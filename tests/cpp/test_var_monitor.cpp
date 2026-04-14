/**
 * Tests unitarios para VarMonitor (API pública de libvarmonitor).
 * Cubre: registro de variables, tipos, get/set, dirty tracking,
 *        client count, ciclo de vida start/stop.
 */

#include <gtest/gtest.h>
#include <var_monitor.hpp>
#include <cmath>
#include <string>
#include <vector>
#include <mutex>

using namespace varmon;

// ── Registro y lectura de variables ──

TEST(VarMonitorRegister, RegisterDoubleAndGet) {
    VarMonitor mon;
    double val = 3.14;
    mon.register_var("test.double", &val);

    auto snap = mon.get_var("test.double");
    ASSERT_TRUE(snap.has_value());
    EXPECT_EQ(snap->name, "test.double");
    EXPECT_DOUBLE_EQ(std::get<double>(snap->value), 3.14);
}

TEST(VarMonitorRegister, RegisterInt32AndGet) {
    VarMonitor mon;
    int32_t val = 42;
    mon.register_var("test.int", &val);

    auto snap = mon.get_var("test.int");
    ASSERT_TRUE(snap.has_value());
    EXPECT_EQ(std::get<int32_t>(snap->value), 42);
}

TEST(VarMonitorRegister, RegisterBoolAndGet) {
    VarMonitor mon;
    bool val = true;
    mon.register_var("test.bool", &val);

    auto snap = mon.get_var("test.bool");
    ASSERT_TRUE(snap.has_value());
    EXPECT_EQ(std::get<bool>(snap->value), true);
}

TEST(VarMonitorRegister, RegisterStringAndGet) {
    VarMonitor mon;
    std::string val = "hello";
    mon.register_var("test.string", &val);

    auto snap = mon.get_var("test.string");
    ASSERT_TRUE(snap.has_value());
    EXPECT_EQ(std::get<std::string>(snap->value), "hello");
}

TEST(VarMonitorRegister, RegisterFloatConvertedToDouble) {
    VarMonitor mon;
    float val = 2.5f;
    mon.register_var("test.float", &val);

    auto snap = mon.get_var("test.float");
    ASSERT_TRUE(snap.has_value());
    EXPECT_NEAR(std::get<double>(snap->value), 2.5, 1e-5);
}

TEST(VarMonitorRegister, RegisterUint32) {
    VarMonitor mon;
    uint32_t val = 1000;
    mon.register_var("test.uint32", &val);

    auto snap = mon.get_var("test.uint32");
    ASSERT_TRUE(snap.has_value());
    EXPECT_DOUBLE_EQ(std::get<double>(snap->value), 1000.0);
}

TEST(VarMonitorRegister, RegisterCharArray) {
    VarMonitor mon;
    char buf[32] = "test_string";
    mon.register_char_array("test.cstr", buf, sizeof(buf));

    auto snap = mon.get_var("test.cstr");
    ASSERT_TRUE(snap.has_value());
    EXPECT_EQ(std::get<std::string>(snap->value), "test_string");
}

TEST(VarMonitorRegister, RegisterArrayPtr) {
    VarMonitor mon;
    double arr[4] = {1.0, 2.0, 3.0, 4.0};
    mon.register_array("test.arr", arr, 4);

    auto snap = mon.get_var("test.arr");
    ASSERT_TRUE(snap.has_value());
    auto& vec = std::get<std::vector<double>>(snap->value);
    ASSERT_EQ(vec.size(), 4u);
    EXPECT_DOUBLE_EQ(vec[0], 1.0);
    EXPECT_DOUBLE_EQ(vec[3], 4.0);
}

TEST(VarMonitorRegister, RegisterArrayVector) {
    VarMonitor mon;
    std::vector<double> vec = {10.0, 20.0, 30.0};
    std::mutex mtx;
    mon.register_array("test.vec", vec, mtx);

    auto snap = mon.get_var("test.vec");
    ASSERT_TRUE(snap.has_value());
    auto& result = std::get<std::vector<double>>(snap->value);
    ASSERT_EQ(result.size(), 3u);
    EXPECT_DOUBLE_EQ(result[1], 20.0);
}

// ── Duplicados ──

TEST(VarMonitorRegister, DuplicateNameIgnored) {
    VarMonitor mon;
    double val1 = 1.0, val2 = 2.0;
    mon.register_var("dup", &val1);
    mon.register_var("dup", &val2);

    auto snap = mon.get_var("dup");
    ASSERT_TRUE(snap.has_value());
    EXPECT_DOUBLE_EQ(std::get<double>(snap->value), 1.0);
}

// ── Unregister ──

TEST(VarMonitorUnregister, UnregisterRemoves) {
    VarMonitor mon;
    double val = 5.0;
    mon.register_var("to_remove", &val);
    EXPECT_TRUE(mon.unregister_var("to_remove"));
    EXPECT_FALSE(mon.get_var("to_remove").has_value());
}

TEST(VarMonitorUnregister, UnregisterNonexistentReturnsFalse) {
    VarMonitor mon;
    EXPECT_FALSE(mon.unregister_var("nonexistent"));
}

TEST(VarMonitorUnregister, UnregisterAll) {
    VarMonitor mon;
    double a = 1.0, b = 2.0;
    mon.register_var("a", &a);
    mon.register_var("b", &b);
    mon.unregister_all();

    auto names = mon.list_var_names();
    EXPECT_TRUE(names.empty());
}

// ── list_vars / list_var_names ──

TEST(VarMonitorList, ListVarNames) {
    VarMonitor mon;
    double a = 1.0;
    int32_t b = 2;
    mon.register_var("alpha", &a);
    mon.register_var("beta", &b);

    auto names = mon.list_var_names();
    EXPECT_EQ(names.size(), 2u);
}

TEST(VarMonitorList, ListVars) {
    VarMonitor mon;
    double val = 3.14;
    mon.register_var("pi", &val);

    auto vars = mon.list_vars();
    ASSERT_EQ(vars.size(), 1u);
    EXPECT_EQ(vars[0].name, "pi");
}

TEST(VarMonitorList, GetVarNotFound) {
    VarMonitor mon;
    EXPECT_FALSE(mon.get_var("nonexistent").has_value());
}

// ── set_var con coerción ──

TEST(VarMonitorSet, SetDoubleVar) {
    VarMonitor mon;
    double val = 0.0;
    mon.register_var("x", &val);
    bool ok = mon.set_var("x", VarValue(42.0));
    EXPECT_TRUE(ok);

    auto snap = mon.get_var("x");
    EXPECT_DOUBLE_EQ(std::get<double>(snap->value), 42.0);
}

TEST(VarMonitorSet, SetInt32Var) {
    VarMonitor mon;
    int32_t val = 0;
    mon.register_var("i", &val);
    bool ok = mon.set_var("i", VarValue(int32_t(99)));
    EXPECT_TRUE(ok);

    auto snap = mon.get_var("i");
    EXPECT_EQ(std::get<int32_t>(snap->value), 99);
}

TEST(VarMonitorSet, SetBoolVar) {
    VarMonitor mon;
    bool val = false;
    mon.register_var("flag", &val);
    bool ok = mon.set_var("flag", VarValue(true));
    EXPECT_TRUE(ok);

    auto snap = mon.get_var("flag");
    EXPECT_TRUE(std::get<bool>(snap->value));
}

TEST(VarMonitorSet, SetVarNonexistentReturnsFalse) {
    VarMonitor mon;
    EXPECT_FALSE(mon.set_var("nope", VarValue(1.0)));
}

TEST(VarMonitorSet, SetArrayElement) {
    VarMonitor mon;
    double arr[3] = {0.0, 0.0, 0.0};
    mon.register_array("arr", arr, 3);

    bool ok = mon.set_array_element("arr", 1, 99.0);
    EXPECT_TRUE(ok);
    EXPECT_DOUBLE_EQ(arr[1], 99.0);
}

// ── Dirty tracking ──

TEST(VarMonitorDirty, MarkDirtyAndCheck) {
    VarMonitor mon;
    double val = 1.0;
    mon.register_var("d", &val);
    mon.mark_dirty("d");
    EXPECT_TRUE(mon.shm_should_fetch_for_publish("d", false));
}

TEST(VarMonitorDirty, DirtyConsumedOnFetch) {
    VarMonitor mon;
    double val = 1.0;
    mon.register_var("d", &val);
    mon.mark_dirty("d");
    mon.shm_should_fetch_for_publish("d", false);
    EXPECT_FALSE(mon.shm_should_fetch_for_publish("d", false));
}

TEST(VarMonitorDirty, FullRefreshAlwaysTrue) {
    VarMonitor mon;
    double val = 1.0;
    mon.register_var("d", &val);
    EXPECT_TRUE(mon.shm_should_fetch_for_publish("d", true));
}

TEST(VarMonitorDirty, ClearAllDirty) {
    VarMonitor mon;
    double a = 1.0, b = 2.0;
    mon.register_var("a", &a);
    mon.register_var("b", &b);
    mon.mark_dirty("a");
    mon.mark_dirty("b");
    mon.shm_clear_all_dirty();
    EXPECT_FALSE(mon.shm_should_fetch_for_publish("a", false));
    EXPECT_FALSE(mon.shm_should_fetch_for_publish("b", false));
}

// ── Client count ──

TEST(VarMonitorClient, ClientConnectDisconnect) {
    VarMonitor mon;
    EXPECT_EQ(mon.client_count(), 0);
    mon.client_connected();
    mon.client_connected();
    EXPECT_EQ(mon.client_count(), 2);
    mon.client_disconnected();
    EXPECT_EQ(mon.client_count(), 1);
}

// ── Slot reuse ──

TEST(VarMonitorSlotReuse, ReuseAfterUnregister) {
    VarMonitor mon;
    double a = 1.0, b = 2.0, c = 3.0;
    mon.register_var("a", &a);
    mon.register_var("b", &b);
    mon.unregister_var("a");
    mon.register_var("c", &c);

    EXPECT_FALSE(mon.get_var("a").has_value());
    EXPECT_TRUE(mon.get_var("b").has_value());
    EXPECT_TRUE(mon.get_var("c").has_value());

    auto names = mon.list_var_names();
    EXPECT_EQ(names.size(), 2u);
}

// ── Valor refleja cambio en memoria ──

TEST(VarMonitorLive, ValueReflectsMemoryChange) {
    VarMonitor mon;
    double val = 10.0;
    mon.register_var("live", &val);

    val = 99.0;
    auto snap = mon.get_var("live");
    EXPECT_DOUBLE_EQ(std::get<double>(snap->value), 99.0);
}

TEST(VarMonitorLive, BoolValueReflects) {
    VarMonitor mon;
    bool val = false;
    mon.register_var("live_bool", &val);

    val = true;
    auto snap = mon.get_var("live_bool");
    EXPECT_TRUE(std::get<bool>(snap->value));
}
