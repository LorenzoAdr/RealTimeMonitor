/* monitor.x - Definicion de interfaz RPC para el monitor de variables */

const MAX_NAME_LEN = 256;
const MAX_VARS = 4096;
const MAX_HISTORY = 2000;
const MAX_STR_VAL = 1024;

enum var_type_t {
    VAR_TYPE_DOUBLE = 0,
    VAR_TYPE_INT32  = 1,
    VAR_TYPE_BOOL   = 2,
    VAR_TYPE_STRING = 3
};

typedef string var_name_arg<MAX_NAME_LEN>;

struct var_value_t {
    double   d_val;
    int      i_val;
    int      b_val;
    string   s_val<MAX_STR_VAL>;
};

struct var_info_t {
    string      name<MAX_NAME_LEN>;
    var_type_t  type;
    var_value_t value;
    unsigned int timestamp_sec;
    unsigned int timestamp_usec;
};

struct var_list_t {
    var_info_t vars<MAX_VARS>;
};

struct var_history_t {
    string       name<MAX_NAME_LEN>;
    double       values<MAX_HISTORY>;
    unsigned int timestamps_sec<MAX_HISTORY>;
    unsigned int timestamps_usec<MAX_HISTORY>;
    int          count;
};

struct set_request_t {
    string      name<MAX_NAME_LEN>;
    var_value_t value;
};

struct set_response_t {
    int    success;
    string message<MAX_STR_VAL>;
};

struct var_names_t {
    var_name_arg names<MAX_VARS>;
};

program VARMONITOR_PROG {
    version VARMONITOR_V1 {
        var_list_t     VARMON_LIST_VARS(void)           = 1;
        var_info_t     VARMON_GET_VAR(var_name_arg)      = 2;
        set_response_t VARMON_SET_VAR(set_request_t)     = 3;
        var_history_t  VARMON_GET_HISTORY(var_name_arg)   = 4;
        var_names_t    VARMON_LIST_NAMES(void)            = 5;
    } = 1;
} = 0x20000099;
