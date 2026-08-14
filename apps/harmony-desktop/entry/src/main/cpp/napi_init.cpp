#include "napi/native_api.h"
#include "gateway_stub.h"

#include <string>
#include <vector>

namespace {

bool ReadUtf8String(napi_env env, napi_value value, std::string &out)
{
    size_t len = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) {
        return false;
    }
    std::vector<char> buf(len + 1, '\0');
    size_t written = 0;
    if (napi_get_value_string_utf8(env, value, buf.data(), buf.size(), &written) != napi_ok) {
        return false;
    }
    out.assign(buf.data(), written);
    return true;
}

// startInProcess(listen, dataDir, token, staticRoot?): number
// dataDir reserved for future Go host; staticRoot serves product-core web assets.
static napi_value StartInProcess(napi_env env, napi_callback_info info)
{
    size_t argc = 4;
    napi_value argv[4] = {nullptr, nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) {
        napi_throw_error(env, nullptr, "startInProcess(listen, dataDir, token, staticRoot?) requires 3+ strings");
        return nullptr;
    }
    std::string listen;
    std::string token;
    std::string staticRoot;
    if (!ReadUtf8String(env, argv[0], listen) || !ReadUtf8String(env, argv[2], token)) {
        napi_throw_error(env, nullptr, "listen/token must be strings");
        return nullptr;
    }
    if (argc >= 4 && argv[3] != nullptr) {
        napi_valuetype vt = napi_undefined;
        napi_typeof(env, argv[3], &vt);
        if (vt == napi_string) {
            ReadUtf8String(env, argv[3], staticRoot);
        }
    }
    int rc = GatewayStubStart(listen.c_str(), token.c_str(),
        staticRoot.empty() ? nullptr : staticRoot.c_str());
    if (rc != 0) {
        const char *err = GatewayStubLastError();
        std::string msg = "GatewayStubStart failed code=" + std::to_string(rc);
        if (err != nullptr && err[0] != '\0') {
            msg += " err=";
            msg += err;
        }
        napi_throw_error(env, nullptr, msg.c_str());
        return nullptr;
    }
    napi_value result;
    napi_create_int32(env, 0, &result);
    return result;
}

static napi_value StopInProcess(napi_env env, napi_callback_info info)
{
    (void)info;
    GatewayStubStop();
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value IsInProcessRunning(napi_env env, napi_callback_info info)
{
    (void)info;
    napi_value result;
    napi_get_boolean(env, GatewayStubIsRunning() != 0, &result);
    return result;
}

static napi_value NativeLibDirNapi(napi_env env, napi_callback_info info)
{
    (void)info;
    napi_value result;
    napi_create_string_utf8(env, "in-process:gateway-stub", NAPI_AUTO_LENGTH, &result);
    return result;
}

} // namespace

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor desc[] = {
        {"startInProcess", nullptr, StartInProcess, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopInProcess", nullptr, StopInProcess, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"isInProcessRunning", nullptr, IsInProcessRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeLibDir", nullptr, NativeLibDirNapi, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
EXTERN_C_END

static napi_module runtimeSpawnModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "runtime_spawn",
    .nm_priv = ((void *)0),
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterRuntimeSpawnModule(void)
{
    napi_module_register(&runtimeSpawnModule);
}
