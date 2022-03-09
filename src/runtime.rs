use crate::bindings;
use crate::errors::{generic_error, unwrap_or_exit, JsError};
use crate::hooks::module_resolve_cb;
use crate::modules::{create_origin, fetch_module_tree, resolve_import, ModuleMap};
use crate::stdio;
use crate::timers::{self, Timeout};
use anyhow::{bail, Error};
use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::Once;
use std::time::Duration;
use std::time::Instant;

/// Function pointer for the bindings initializers.
type BindingInitFn = fn(&mut v8::HandleScope<'_>) -> v8::Global<v8::Object>;

/// Type of completion of an asynchronous operation.
pub enum AsyncHandle {
    /// JavaScript promise.
    Promise(v8::Global<v8::PromiseResolver>),
    /// JavaScript callback.
    Callback(v8::Global<v8::Function>),
}

/// The state to be stored per v8 isolate.
pub struct JsRuntimeState {
    /// A sand-boxed execution context with its own set of built-in objects and functions.
    pub context: v8::Global<v8::Context>,
    /// Holds information about resolved ES modules.
    pub modules: ModuleMap,
    /// Holds native bindings.
    pub bindings: HashMap<&'static str, BindingInitFn>,
    /// Holds the timers.
    pub(crate) timers: BTreeMap<Instant, Timeout>,
    /// Holds completion handles for async operations.
    pub(crate) async_handles: HashMap<usize, AsyncHandle>,
}

pub struct JsRuntime {
    /// A VM instance with its own heap.
    /// https://v8docs.nodesource.com/node-0.8/d5/dda/classv8_1_1_isolate.html
    isolate: v8::OwnedIsolate,
}

impl JsRuntime {
    pub fn new() -> JsRuntime {
        // Firing up the v8 engine under the hood.
        static V8_INIT: Once = Once::new();
        V8_INIT.call_once(move || {
            let platform = v8::new_default_platform(0, false).make_shared();
            v8::V8::initialize_platform(platform);
            v8::V8::initialize();
        });

        let flags = concat!(
            " --harmony-import-assertions",
            " --harmony-top-level-await false"
        );
        v8::V8::set_flags_from_string(flags);

        let mut isolate = v8::Isolate::new(v8::CreateParams::default());

        isolate.set_capture_stack_trace_for_uncaught_exceptions(true, 10);

        let context = {
            let scope = &mut v8::HandleScope::new(&mut isolate);
            let context = bindings::create_new_context(scope);
            v8::Global::new(scope, context)
        };

        let bindings: Vec<(&'static str, BindingInitFn)> = vec![
            ("stdio", stdio::initialize),
            ("timer_wrap", timers::initialize),
        ];

        let bindings = HashMap::from_iter(bindings.into_iter());

        // Storing state inside the v8 isolate slot.
        // https://v8docs.nodesource.com/node-4.8/d5/dda/classv8_1_1_isolate.html#a7acadfe7965997e9c386a05f098fbe36
        isolate.set_slot(Rc::new(RefCell::new(JsRuntimeState {
            context,
            bindings,
            modules: ModuleMap::default(),
            timers: BTreeMap::default(),
            async_handles: HashMap::default(),
        })));

        let mut runtime = JsRuntime { isolate };

        // Initializing the core environment. (see lib/main.js)
        let main = include_str!("../lib/main.js");
        unwrap_or_exit(runtime.execute_module("dune:environment/main", Some(main)));

        runtime
    }

    /// Executes traditional JavaScript code (traditional = not ES modules).
    pub fn execute_script(
        &mut self,
        filename: &str,
        source: &str,
    ) -> Result<v8::Global<v8::Value>, Error> {
        // Getting a reference to isolate's handle scope.
        let scope = &mut self.handle_scope();

        let origin = create_origin(scope, filename, false);
        let source = v8::String::new(scope, source).unwrap();

        // The `TryCatch` scope allows us to catch runtime errors rather than panicking.
        let tc_scope = &mut v8::TryCatch::new(scope);

        let script = match v8::Script::compile(tc_scope, source, Some(&origin)) {
            Some(script) => script,
            None => {
                assert!(tc_scope.has_caught());
                let exception = tc_scope.exception().unwrap();
                bail!(JsError::from_v8_exception(tc_scope, exception));
            }
        };

        match script.run(tc_scope) {
            Some(value) => Ok(v8::Global::new(tc_scope, value)),
            None => {
                assert!(tc_scope.has_caught());
                let exception = tc_scope.exception().unwrap();
                bail!(JsError::from_v8_exception(tc_scope, exception));
            }
        }
    }

    /// Executes JavaScript ES modules.
    pub fn execute_module(
        &mut self,
        filename: &str,
        source: Option<&str>,
    ) -> Result<v8::Global<v8::Value>, Error> {
        // The following code allows the runtime to load the core JavaScript
        // environment (lib/main.js) that does not have a valid
        // filename since it's loaded from memory.
        let filename = match source.is_some() {
            true => filename.to_string(),
            false => unwrap_or_exit(resolve_import(None, filename)),
        };

        let scope = &mut self.handle_scope();
        let tc_scope = &mut v8::TryCatch::new(scope);

        let module = match fetch_module_tree(tc_scope, &filename, source) {
            Some(module) => module,
            None => {
                assert!(tc_scope.has_caught());
                let exception = tc_scope.exception().unwrap();
                bail!(JsError::from_v8_exception(tc_scope, exception));
            }
        };

        if module
            .instantiate_module(tc_scope, module_resolve_cb)
            .is_none()
        {
            assert!(tc_scope.has_caught());
            let exception = tc_scope.exception().unwrap();
            bail!(JsError::from_v8_exception(tc_scope, exception));
        }

        let module_result = module.evaluate(tc_scope);

        if module.get_status() == v8::ModuleStatus::Errored {
            let exception = module.get_exception();
            bail!(JsError::from_v8_exception(tc_scope, exception));
        }

        match module_result {
            Some(value) => Ok(v8::Global::new(tc_scope, value)),
            None => bail!(generic_error(
                "Cannot evaluate module, because JavaScript execution has been terminated."
            )),
        }
    }
}

// ----------------------------------------------------
// State management implementation.
// ----------------------------------------------------

impl JsRuntime {
    /// Returns the runtime state stored in the given isolate.
    pub fn state(isolate: &v8::Isolate) -> Rc<RefCell<JsRuntimeState>> {
        isolate
            .get_slot::<Rc<RefCell<JsRuntimeState>>>()
            .unwrap()
            .clone()
    }

    /// Returns the runtime's state.
    pub fn get_state(&self) -> Rc<RefCell<JsRuntimeState>> {
        Self::state(&self.isolate)
    }

    /// Returns a v8 handle scope for the runtime.
    /// https://v8docs.nodesource.com/node-0.8/d3/d95/classv8_1_1_handle_scope.html.
    pub fn handle_scope(&mut self) -> v8::HandleScope {
        let context = self.context();
        v8::HandleScope::with_context(&mut self.isolate, context)
    }

    /// Returns a context created for the runtime.
    /// https://v8docs.nodesource.com/node-0.8/df/d69/classv8_1_1_context.html
    pub fn context(&mut self) -> v8::Global<v8::Context> {
        let state = self.get_state();
        let state = state.borrow();
        state.context.clone()
    }
}

// ----------------------------------------------------
// Event-Loop specific methods.
// ----------------------------------------------------

impl JsRuntime {
    /// Enrolls an async handle to the event-loop.
    pub fn ev_enroll_async_handle(isolate: &v8::Isolate, handle: AsyncHandle) -> usize {
        // We need to get a mut reference to the isolate's state first.
        let state = Self::state(isolate);
        let mut state = state.borrow_mut();
        // The length of the hashmap will be the next key. (for now!)
        let key = state.async_handles.len();
        state.async_handles.insert(key, handle);

        key
    }

    // Enrolls a new timeout to the timers shorted list.
    pub fn ev_enroll_timeout(isolate: &v8::Isolate, timeout: Timeout) {
        // We need to get a mut reference to the isolate's state first.
        let state = Self::state(isolate);
        let mut state = state.borrow_mut();
        // Calculate the next time the timeout will go OFF!
        let now = Instant::now();
        let duration = now + Duration::from_millis(timeout.delay);

        state.timers.insert(duration, timeout);
    }
}
