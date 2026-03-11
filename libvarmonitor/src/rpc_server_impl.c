#include "monitor.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

extern int varmon_bridge_list_vars(var_list_t *result);
extern int varmon_bridge_list_names(var_names_t *result);
extern int varmon_bridge_get_var(char *name, var_info_t *result);
extern int varmon_bridge_set_var(set_request_t *req, set_response_t *result);
extern int varmon_bridge_get_history(char *name, var_history_t *result);

var_list_t *
varmon_list_vars_1_svc(void *argp, struct svc_req *rqstp)
{
    static var_list_t result;
    xdr_free((xdrproc_t)xdr_var_list_t, (char *)&result);
    memset(&result, 0, sizeof(result));
    varmon_bridge_list_vars(&result);
    return &result;
}

var_info_t *
varmon_get_var_1_svc(var_name_arg *argp, struct svc_req *rqstp)
{
    static var_info_t result;
    xdr_free((xdrproc_t)xdr_var_info_t, (char *)&result);
    memset(&result, 0, sizeof(result));
    if (argp && *argp) {
        varmon_bridge_get_var(*argp, &result);
    }
    return &result;
}

set_response_t *
varmon_set_var_1_svc(set_request_t *argp, struct svc_req *rqstp)
{
    static set_response_t result;
    xdr_free((xdrproc_t)xdr_set_response_t, (char *)&result);
    memset(&result, 0, sizeof(result));
    varmon_bridge_set_var(argp, &result);
    return &result;
}

var_history_t *
varmon_get_history_1_svc(var_name_arg *argp, struct svc_req *rqstp)
{
    static var_history_t result;
    xdr_free((xdrproc_t)xdr_var_history_t, (char *)&result);
    memset(&result, 0, sizeof(result));
    if (argp && *argp) {
        varmon_bridge_get_history(*argp, &result);
    }
    return &result;
}

var_names_t *
varmon_list_names_1_svc(void *argp, struct svc_req *rqstp)
{
    static var_names_t result;
    xdr_free((xdrproc_t)xdr_var_names_t, (char *)&result);
    memset(&result, 0, sizeof(result));
    varmon_bridge_list_names(&result);
    return &result;
}
