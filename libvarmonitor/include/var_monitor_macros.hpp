#pragma once

#ifdef VARMON_ENABLED

#include "var_monitor.hpp"
#include <memory>

namespace varmon { namespace detail {
    inline VarMonitor*& macro_instance() {
        static VarMonitor* inst = nullptr;
        return inst;
    }
    inline VarMonitor& ensure_instance(size_t cap = 2000) {
        if (!macro_instance()) {
            macro_instance() = new VarMonitor(cap);
            set_global_instance(macro_instance());
        }
        return *macro_instance();
    }
}} // namespace varmon::detail

#define VARMON_WATCH(name, var) \
    varmon::detail::ensure_instance().register_var(name, &(var))

#define VARMON_WATCH_FN(name, getter_fn, setter_fn) \
    varmon::detail::ensure_instance().register_var( \
        name, varmon::VarType::Double, \
        [&]() -> varmon::VarValue { return (getter_fn)(); }, \
        [&](const varmon::VarValue& _v) { (setter_fn)(std::get<double>(_v)); })

#define VARMON_SET_CONFIG(path) \
    varmon::set_config_path(path)

#define VARMON_START(interval_ms) \
    varmon::detail::ensure_instance(2000).start(interval_ms)

#define VARMON_UNWATCH(name) \
    do { auto* _inst = varmon::detail::macro_instance(); \
         if (_inst) _inst->unregister_var(name); } while(0)

#define VARMON_UNWATCH_ALL() \
    do { auto* _inst = varmon::detail::macro_instance(); \
         if (_inst) _inst->unregister_all(); } while(0)

#define VARMON_STOP() \
    do { \
        auto* _inst = varmon::detail::macro_instance(); \
        if (_inst) { _inst->stop(); delete _inst; varmon::detail::macro_instance() = nullptr; } \
    } while(0)

#else

#define VARMON_WATCH(name, var)                   ((void)0)
#define VARMON_WATCH_FN(name, getter_fn, setter_fn) ((void)0)
#define VARMON_SET_CONFIG(path)                     ((void)0)
#define VARMON_UNWATCH(name)                       ((void)0)
#define VARMON_UNWATCH_ALL()                       ((void)0)
#define VARMON_START(interval_ms)                  ((void)0)
#define VARMON_STOP()                              ((void)0)

#endif
