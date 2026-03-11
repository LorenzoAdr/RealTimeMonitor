#include "var_monitor.hpp"
#include <cstring>
#include <chrono>

extern "C" {
#include "monitor.h"
}

static void timepoint_to_sec_usec(std::chrono::system_clock::time_point tp,
                                   unsigned int& sec, unsigned int& usec) {
    auto duration = tp.time_since_epoch();
    auto secs = std::chrono::duration_cast<std::chrono::seconds>(duration);
    auto usecs = std::chrono::duration_cast<std::chrono::microseconds>(duration - secs);
    sec = static_cast<unsigned int>(secs.count());
    usec = static_cast<unsigned int>(usecs.count());
}

static void fill_var_info(var_info_t* info, const varmon::VarMonitor::VarSnapshot& snap) {
    info->name = strdup(snap.name.c_str());
    info->type = static_cast<var_type_t>(snap.type);
    info->value.d_val = 0;
    info->value.i_val = 0;
    info->value.b_val = 0;
    info->value.s_val = strdup("");

    switch (snap.type) {
        case varmon::VarType::Double:
            info->value.d_val = std::get<double>(snap.value);
            break;
        case varmon::VarType::Int32:
            info->value.i_val = std::get<int32_t>(snap.value);
            info->value.d_val = static_cast<double>(info->value.i_val);
            break;
        case varmon::VarType::Bool:
            info->value.b_val = std::get<bool>(snap.value) ? 1 : 0;
            info->value.d_val = info->value.b_val ? 1.0 : 0.0;
            break;
        case varmon::VarType::String:
            free(info->value.s_val);
            info->value.s_val = strdup(std::get<std::string>(snap.value).c_str());
            break;
    }
    timepoint_to_sec_usec(snap.time, info->timestamp_sec, info->timestamp_usec);
}

extern "C" int varmon_bridge_list_vars(var_list_t* result) {
    auto* mon = varmon::get_global_instance();
    if (!mon) return -1;

    auto vars = mon->list_vars();
    result->vars.vars_len = static_cast<u_int>(vars.size());
    result->vars.vars_val = (var_info_t*)calloc(vars.size(), sizeof(var_info_t));

    for (size_t i = 0; i < vars.size(); ++i) {
        fill_var_info(&result->vars.vars_val[i], vars[i]);
    }
    return 0;
}

extern "C" int varmon_bridge_list_names(var_names_t* result) {
    auto* mon = varmon::get_global_instance();
    if (!mon) return -1;

    auto names = mon->list_var_names();
    result->names.names_len = static_cast<u_int>(names.size());
    result->names.names_val = (char**)calloc(names.size(), sizeof(char*));

    for (size_t i = 0; i < names.size(); ++i) {
        result->names.names_val[i] = strdup(names[i].c_str());
    }
    return 0;
}

extern "C" int varmon_bridge_get_var(char* name, var_info_t* result) {
    auto* mon = varmon::get_global_instance();
    if (!mon) return -1;

    auto snap = mon->get_var(name);
    if (!snap) {
        result->name = strdup(name);
        result->value.s_val = strdup("");
        return -1;
    }
    fill_var_info(result, *snap);
    return 0;
}

extern "C" int varmon_bridge_set_var(set_request_t* req, set_response_t* result) {
    auto* mon = varmon::get_global_instance();
    if (!mon) {
        result->success = 0;
        result->message = strdup("Monitor no inicializado");
        return -1;
    }

    varmon::VarValue val;
    auto var_snap = mon->get_var(req->name);
    if (!var_snap) {
        result->success = 0;
        result->message = strdup("Variable no encontrada");
        return -1;
    }

    switch (var_snap->type) {
        case varmon::VarType::Double: val = req->value.d_val; break;
        case varmon::VarType::Int32:  val = static_cast<int32_t>(req->value.i_val); break;
        case varmon::VarType::Bool:   val = (bool)(req->value.b_val != 0); break;
        case varmon::VarType::String: val = std::string(req->value.s_val); break;
    }

    if (mon->set_var(req->name, val)) {
        result->success = 1;
        result->message = strdup("OK");
    } else {
        result->success = 0;
        result->message = strdup("No se pudo setear la variable (read-only?)");
    }
    return 0;
}

extern "C" int varmon_bridge_get_history(char* name, var_history_t* result) {
    auto* mon = varmon::get_global_instance();
    if (!mon) return -1;

    auto hist = mon->get_history(name);
    if (!hist) {
        result->name = strdup(name);
        result->count = 0;
        result->values.values_len = 0;
        result->values.values_val = nullptr;
        result->timestamps_sec.timestamps_sec_len = 0;
        result->timestamps_sec.timestamps_sec_val = nullptr;
        result->timestamps_usec.timestamps_usec_len = 0;
        result->timestamps_usec.timestamps_usec_val = nullptr;
        return -1;
    }

    size_t count = hist->values.size();
    result->name = strdup(name);
    result->count = static_cast<int>(count);

    result->values.values_len = static_cast<u_int>(count);
    result->values.values_val = (double*)calloc(count, sizeof(double));

    result->timestamps_sec.timestamps_sec_len = static_cast<u_int>(count);
    result->timestamps_sec.timestamps_sec_val = (u_int*)calloc(count, sizeof(u_int));

    result->timestamps_usec.timestamps_usec_len = static_cast<u_int>(count);
    result->timestamps_usec.timestamps_usec_val = (u_int*)calloc(count, sizeof(u_int));

    for (size_t i = 0; i < count; ++i) {
        result->values.values_val[i] = hist->values[i];
        unsigned int sec, usec;
        timepoint_to_sec_usec(hist->timestamps[i], sec, usec);
        result->timestamps_sec.timestamps_sec_val[i] = sec;
        result->timestamps_usec.timestamps_usec_val[i] = usec;
    }
    return 0;
}
