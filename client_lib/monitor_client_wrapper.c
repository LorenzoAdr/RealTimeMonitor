#include "monitor_client_wrapper.h"
#include "monitor.h"
#include <string.h>
#include <stdlib.h>

struct client_ctx {
    CLIENT* clnt;
};

moncli_handle moncli_connect(const char* host) {
    CLIENT* clnt = clnt_create(host, VARMONITOR_PROG, VARMONITOR_V1, "tcp");
    if (!clnt) return NULL;

    struct timeval tv = {5, 0};
    clnt_control(clnt, CLSET_TIMEOUT, (char*)&tv);

    struct client_ctx* ctx = (struct client_ctx*)calloc(1, sizeof(*ctx));
    ctx->clnt = clnt;
    return ctx;
}

void moncli_disconnect(moncli_handle h) {
    if (!h) return;
    struct client_ctx* ctx = (struct client_ctx*)h;
    if (ctx->clnt) clnt_destroy(ctx->clnt);
    free(ctx);
}

static void copy_var_info(moncli_var_info* dst, var_info_t* src) {
    memset(dst, 0, sizeof(*dst));
    if (src->name)
        strncpy(dst->name, src->name, MONCLI_MAX_NAME - 1);
    dst->type = (int)src->type;
    dst->d_val = src->value.d_val;
    dst->i_val = src->value.i_val;
    dst->b_val = src->value.b_val;
    if (src->value.s_val)
        strncpy(dst->s_val, src->value.s_val, MONCLI_MAX_STR - 1);
    dst->timestamp_sec = src->timestamp_sec;
    dst->timestamp_usec = src->timestamp_usec;
}

int moncli_list_vars(moncli_handle h, moncli_var_list* out) {
    if (!h || !out) return -1;
    struct client_ctx* ctx = (struct client_ctx*)h;
    memset(out, 0, sizeof(*out));

    char dummy = 0;
    var_list_t* result = varmon_list_vars_1((void*)&dummy, ctx->clnt);
    if (!result) return -1;

    out->count = (int)result->vars.vars_len;
    if (out->count > MONCLI_MAX_VARS) out->count = MONCLI_MAX_VARS;

    for (int i = 0; i < out->count; i++) {
        copy_var_info(&out->vars[i], &result->vars.vars_val[i]);
    }
    return 0;
}

int moncli_list_names(moncli_handle h, moncli_name_list* out) {
    if (!h || !out) return -1;
    struct client_ctx* ctx = (struct client_ctx*)h;
    memset(out, 0, sizeof(*out));

    char dummy = 0;
    var_names_t* result = varmon_list_names_1((void*)&dummy, ctx->clnt);
    if (!result) return -1;

    out->count = (int)result->names.names_len;
    if (out->count > MONCLI_MAX_VARS) out->count = MONCLI_MAX_VARS;

    for (int i = 0; i < out->count; i++) {
        if (result->names.names_val[i])
            strncpy(out->names[i], result->names.names_val[i], MONCLI_MAX_NAME - 1);
    }
    return 0;
}

int moncli_get_var(moncli_handle h, const char* name, moncli_var_info* out) {
    if (!h || !name || !out) return -1;
    struct client_ctx* ctx = (struct client_ctx*)h;
    memset(out, 0, sizeof(*out));

    char* arg = (char*)name;
    var_info_t* result = varmon_get_var_1(&arg, ctx->clnt);
    if (!result) return -1;

    copy_var_info(out, result);
    return 0;
}

static int do_set_var(moncli_handle h, const char* name,
                      double d, int i, int b, const char* s) {
    if (!h || !name) return -1;
    struct client_ctx* ctx = (struct client_ctx*)h;

    set_request_t req;
    memset(&req, 0, sizeof(req));
    req.name = (char*)name;
    req.value.d_val = d;
    req.value.i_val = i;
    req.value.b_val = b;
    req.value.s_val = s ? (char*)s : "";

    set_response_t* result = varmon_set_var_1(&req, ctx->clnt);
    if (!result) return -1;
    return result->success ? 0 : -1;
}

int moncli_set_var_double(moncli_handle h, const char* name, double value) {
    return do_set_var(h, name, value, 0, 0, NULL);
}

int moncli_set_var_int(moncli_handle h, const char* name, int value) {
    return do_set_var(h, name, 0, value, 0, NULL);
}

int moncli_set_var_bool(moncli_handle h, const char* name, int value) {
    return do_set_var(h, name, 0, 0, value, NULL);
}

int moncli_set_var_string(moncli_handle h, const char* name, const char* value) {
    return do_set_var(h, name, 0, 0, 0, value);
}

int moncli_get_history(moncli_handle h, const char* name, moncli_history* out) {
    if (!h || !name || !out) return -1;
    struct client_ctx* ctx = (struct client_ctx*)h;
    memset(out, 0, sizeof(*out));

    char* arg = (char*)name;
    var_history_t* result = varmon_get_history_1(&arg, ctx->clnt);
    if (!result) return -1;

    strncpy(out->name, name, MONCLI_MAX_NAME - 1);
    out->count = result->count;
    if (out->count > MONCLI_MAX_HISTORY) out->count = MONCLI_MAX_HISTORY;

    for (int i = 0; i < out->count; i++) {
        out->values[i] = result->values.values_val[i];
        out->timestamps_sec[i] = result->timestamps_sec.timestamps_sec_val[i];
        out->timestamps_usec[i] = result->timestamps_usec.timestamps_usec_val[i];
    }
    return 0;
}
