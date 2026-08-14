#ifndef PEBBLE_GATEWAY_STUB_H
#define PEBBLE_GATEWAY_STUB_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start loopback HTTP gateway.
 * @param listenAddr e.g. "127.0.0.1:17777"
 * @param token bearer token for /v1/* (empty disables auth)
 * @param staticRoot optional directory for GET static files (may be nullptr)
 */
int GatewayStubStart(const char *listenAddr, const char *token, const char *staticRoot);
void GatewayStubStop(void);
int GatewayStubIsRunning(void);
const char *GatewayStubLastError(void);

#ifdef __cplusplus
}
#endif

#endif
