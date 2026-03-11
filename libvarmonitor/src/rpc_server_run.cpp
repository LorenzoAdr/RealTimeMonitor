#include "var_monitor.hpp"
#include <iostream>

extern "C" {
#include <rpc/rpc.h>
#include <rpc/pmap_clnt.h>
#include <netinet/in.h>
#include "monitor.h"

extern void varmonitor_prog_1(struct svc_req*, SVCXPRT*);
}

namespace varmon {

void VarMonitor::rpc_server_loop() {
    pmap_unset(VARMONITOR_PROG, VARMONITOR_V1);

    SVCXPRT* transp = svctcp_create(RPC_ANYSOCK, 0, 0);
    if (!transp) {
        std::cerr << "[VarMonitor] Error: no se pudo crear transporte TCP\n";
        return;
    }

    if (!svc_register(transp, VARMONITOR_PROG, VARMONITOR_V1,
                      varmonitor_prog_1, IPPROTO_TCP)) {
        std::cerr << "[VarMonitor] Error: no se pudo registrar servicio RPC\n";
        return;
    }

    SVCXPRT* udp_transp = svcudp_create(RPC_ANYSOCK);
    if (udp_transp) {
        svc_register(udp_transp, VARMONITOR_PROG, VARMONITOR_V1,
                     varmonitor_prog_1, IPPROTO_UDP);
    }

    while (running_.load()) {
        fd_set readfds = svc_fdset;
        struct timeval tv = {0, 500000};
        int ret = select(FD_SETSIZE, &readfds, nullptr, nullptr, &tv);
        if (ret > 0) {
            svc_getreqset(&readfds);
        }
    }

    svc_unregister(VARMONITOR_PROG, VARMONITOR_V1);
}

} // namespace varmon
