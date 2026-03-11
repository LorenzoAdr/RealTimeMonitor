#ifndef MONITOR_CLIENT_WRAPPER_H
#define MONITOR_CLIENT_WRAPPER_H

#ifdef __cplusplus
extern "C" {
#endif

#define MONCLI_MAX_VARS    4096
#define MONCLI_MAX_NAME    256
#define MONCLI_MAX_HISTORY 2000
#define MONCLI_MAX_STR     1024

typedef struct {
    char name[MONCLI_MAX_NAME];
    int  type;      /* 0=double, 1=int32, 2=bool, 3=string */
    double d_val;
    int    i_val;
    int    b_val;
    char   s_val[MONCLI_MAX_STR];
    unsigned int timestamp_sec;
    unsigned int timestamp_usec;
} moncli_var_info;

typedef struct {
    moncli_var_info vars[MONCLI_MAX_VARS];
    int count;
} moncli_var_list;

typedef struct {
    char name[MONCLI_MAX_NAME];
    double values[MONCLI_MAX_HISTORY];
    unsigned int timestamps_sec[MONCLI_MAX_HISTORY];
    unsigned int timestamps_usec[MONCLI_MAX_HISTORY];
    int count;
} moncli_history;

typedef struct {
    int success;
    char message[MONCLI_MAX_STR];
} moncli_set_result;

typedef struct {
    char names[MONCLI_MAX_VARS][MONCLI_MAX_NAME];
    int count;
} moncli_name_list;

/* Opaque handle */
typedef void* moncli_handle;

moncli_handle moncli_connect(const char* host);
void          moncli_disconnect(moncli_handle h);

int moncli_list_vars(moncli_handle h, moncli_var_list* out);
int moncli_list_names(moncli_handle h, moncli_name_list* out);
int moncli_get_var(moncli_handle h, const char* name, moncli_var_info* out);
int moncli_set_var_double(moncli_handle h, const char* name, double value);
int moncli_set_var_int(moncli_handle h, const char* name, int value);
int moncli_set_var_bool(moncli_handle h, const char* name, int value);
int moncli_set_var_string(moncli_handle h, const char* name, const char* value);
int moncli_get_history(moncli_handle h, const char* name, moncli_history* out);

#ifdef __cplusplus
}
#endif

#endif
