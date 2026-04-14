#include "var_monitor.hpp"
#include <iostream>
#include <cmath>
#include <csignal>
#include <atomic>
#include <thread>
#include <chrono>
#include <random>
#include <mutex>
#include <cstdint>

static std::atomic<bool> g_running{true};

void signal_handler(int) { g_running = false; }

/** R = A·B (3×3). */
static void mat3_mul(const double A[3][3], const double B[3][3], double R[3][3]) {
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
        }
    }
}

/**
 * Velocidad cuerpo → NED: v_ned = Rz(ψ)·Ry(θ)·Rx(φ)·v_body.
 * Ejes cuerpo: X adelante, Y derecha, Z abajo (mismo orden que el modo visual vuelo en JS).
 */
static void body_vel_to_ned(double roll_deg, double pitch_deg, double yaw_deg, double vx_body, double vy_body, double vz_body,
                            double* vn, double* ve, double* vd) {
    const double pi = 3.14159265358979323846;
    const double rx = roll_deg * pi / 180.0;
    const double ry = pitch_deg * pi / 180.0;
    const double rz = yaw_deg * pi / 180.0;
    const double cx = std::cos(rx), sx = std::sin(rx);
    const double cy = std::cos(ry), sy = std::sin(ry);
    const double cz = std::cos(rz), sz = std::sin(rz);
    const double Rx[3][3] = {{1.0, 0.0, 0.0}, {0.0, cx, -sx}, {0.0, sx, cx}};
    const double Ry[3][3] = {{cy, 0.0, sy}, {0.0, 1.0, 0.0}, {-sy, 0.0, cy}};
    const double Rz[3][3] = {{cz, -sz, 0.0}, {sz, cz, 0.0}, {0.0, 0.0, 1.0}};
    double RyRx[3][3];
    double R[3][3];
    mat3_mul(Ry, Rx, RyRx);
    mat3_mul(Rz, RyRx, R);
    *vn = R[0][0] * vx_body + R[0][1] * vy_body + R[0][2] * vz_body;
    *ve = R[1][0] * vx_body + R[1][1] * vy_body + R[1][2] * vz_body;
    *vd = R[2][0] * vx_body + R[2][1] * vy_body + R[2][2] * vz_body;
}

static uint8_t reverse_bits8(uint8_t x) {
    uint8_t r = 0;
    for (int i = 0; i < 8; ++i) {
        r = static_cast<uint8_t>((r << 1) | (x & 1));
        x >>= 1;
    }
    return r;
}

static uint32_t apply_odd_parity(uint32_t word_31_bits) {
    uint32_t v = word_31_bits & 0x7FFFFFFFu; // sin bit de paridad
    unsigned ones = 0;
    for (uint32_t x = v; x; x &= (x - 1)) ++ones;
    // Paridad impar total incluyendo bit 31.
    if ((ones % 2u) == 0u) {
        v |= 0x80000000u;
    }
    return v;
}

static uint32_t make_arinc429_word(uint8_t label_dec, uint32_t data19, uint8_t ssm, uint8_t sdi = 0) {
    uint32_t word = 0;
    const uint8_t raw_label = reverse_bits8(label_dec);
    word |= static_cast<uint32_t>(raw_label);
    word |= (static_cast<uint32_t>(sdi & 0x3u) << 8);
    word |= ((data19 & 0x7FFFFu) << 10);
    word |= (static_cast<uint32_t>(ssm & 0x3u) << 29);
    return apply_odd_parity(word);
}

/** Invierte el bit de paridad para forzar error de paridad impar ARINC429. */
static uint32_t force_bad_odd_parity(uint32_t word) {
    return word ^ 0x80000000u;
}

static uint32_t encode_bnr_unsigned(double value) {
    long v = std::lround(value);
    if (v < 0) v = 0;
    if (v > 0x7FFFF) v = 0x7FFFF;
    return static_cast<uint32_t>(v);
}

static uint32_t encode_bnr_signed(double value) {
    long v = std::lround(value);
    if (v < -(1 << 18)) v = -(1 << 18);
    if (v > ((1 << 18) - 1)) v = (1 << 18) - 1;
    return static_cast<uint32_t>(v) & 0x7FFFFu;
}

static uint32_t encode_bcd_4digits(unsigned value) {
    value %= 10000u;
    const unsigned d0 = value % 10u;
    const unsigned d1 = (value / 10u) % 10u;
    const unsigned d2 = (value / 100u) % 10u;
    const unsigned d3 = (value / 1000u) % 10u;
    return static_cast<uint32_t>((d3 << 12) | (d2 << 8) | (d1 << 4) | d0);
}

int main() {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    double sine_wave = 0.0;
    double cosine_wave = 0.0;
    double temperature = 20.0;
    double pressure = 1013.25;
    double humidity = 45.0;
    int32_t counter = 0;
    bool flag = false;
    double setpoint = 50.0;
    double pid_kp = 1.5;
    double pid_ki = 0.2;
    double pid_kd = 0.05;
    double pid_output = 0.0;
    double pos_x = 0.0;
    double pos_y = 0.0;
    double vel_x = 0.0;
    double vel_y = 0.0;
    /** Demo visual vuelo (modo flight_viz): ángulos deg; vx solo en cuerpo → NED; altitud coherente con Vd. */
    double flight_roll_deg = 0.0;
    double flight_pitch_deg = 0.0;
    double flight_yaw_deg = 0.0;
    /** Velocidad solo en eje X cuerpo (adelante), m/s. */
    double flight_vx_body = 0.0;
    double flight_vn_ned = 0.0;
    double flight_ve_ned = 0.0;
    double flight_vd_ned = 0.0;
    double flight_pos_d_ned = 0.0;
    double flight_altitude_m = 0.0;
    /** Lat/lon (deg) integrados desde Vn/Ve (tras cuerpo→NED) sobre esfera WGS84 (radio ~6378137 m). */
    double flight_lat_deg = 40.0;
    double flight_lon_deg = -3.0;
    double flight_lat_rad = 40.0 * 3.14159265358979323846 / 180.0;
    double flight_lon_rad = -3.0 * 3.14159265358979323846 / 180.0;
    // Palabras ARINC429 demo para validar decodificaci?n autom?tica con BD importada.
    uint32_t arinc_word_310_ias = 0u;      // IAS_EXAMPLE (bnr)
    uint32_t arinc_word_271_alt_bcd = 0u;  // ALT_BCD_EXAMPLE (bcd)
    uint32_t arinc_word_350_status = 0u;   // STATUS_DIS / GEAR_DISCRETE (discrete)
    uint32_t arinc_word_204_roll = 0u;     // ROLL_DEG (bnr signed, scale 0.01)
    uint32_t arinc_word_206_heading = 0u;  // MAG_HEADING (bnr, scale 0.01)
    uint32_t arinc_word_320_cas = 0u;      // CAS_KT (bnr, scale 0.0625)
    uint32_t arinc_word_310_bad_ssm = 0u;   // BNR: SSM invalido (no 3)
    uint32_t arinc_word_350_bad_ssm = 0u;   // DIS: SSM invalido (no 0)
    uint32_t arinc_word_204_bad_parity = 0u; // BNR: paridad impar incorrecta

    // MIL-STD-1553: cargas escalares; nombres RTn_Wk_SUFFIX coinciden con la BD web (m1553_labels_import.json).
    uint32_t m1553_rt1_w3_alt = 0u;
    uint32_t m1553_rt1_w3_ias = 0u;
    uint32_t m1553_rt1_w3_hdg = 0u;
    uint32_t m1553_rt2_w1_status = 0u;
    uint32_t m1553_rt3_w2_fuel = 0u;
    /** Palabra demo empaquetada (subcampos MSB); coincide con `m1553_packed_word_sample.csv` / registro web. */
    uint32_t m1553_rt1_w3_status_word = 0u;

    // Array est?tico: lectura Y escritura por indice desde el monitor
    double spectrum[32] = {};

    // Vector + mutex: lectura Y escritura por indice desde el monitor
    std::vector<double> sensor_bank(8, 0.0);
    std::mutex sensor_bank_mtx;

    // Array con getter custom: SOLO lectura (no se puede escribir desde el monitor)
    double internal_buf[16] = {};
    std::mutex internal_mtx;

    varmon::VarMonitor monitor;

    monitor.register_var("waves.sine", &sine_wave);
    monitor.register_var("waves.cosine", &cosine_wave);
    monitor.register_var("sensors.temperature", &temperature);
    monitor.register_var("sensors.pressure", &pressure);
    monitor.register_var("sensors.humidity", &humidity);
    monitor.register_var("system.counter", &counter);
    monitor.register_var("system.flag", &flag);
    monitor.register_var("control.setpoint", &setpoint);
    monitor.register_var("control.pid.kp", &pid_kp);
    monitor.register_var("control.pid.ki", &pid_ki);
    monitor.register_var("control.pid.kd", &pid_kd);
    monitor.register_var("control.pid.output", &pid_output);
    monitor.register_var("state.position.x", &pos_x);
    monitor.register_var("state.position.y", &pos_y);
    monitor.register_var("state.velocity.x", &vel_x);
    monitor.register_var("state.velocity.y", &vel_y);
    monitor.register_var("flight_demo.roll_deg", &flight_roll_deg);
    monitor.register_var("flight_demo.pitch_deg", &flight_pitch_deg);
    monitor.register_var("flight_demo.yaw_deg", &flight_yaw_deg);
    monitor.register_var("flight_demo.vx_body", &flight_vx_body);
    monitor.register_var("flight_demo.vn_ned", &flight_vn_ned);
    monitor.register_var("flight_demo.ve_ned", &flight_ve_ned);
    monitor.register_var("flight_demo.vd_ned", &flight_vd_ned);
    monitor.register_var("flight_demo.altitude_m", &flight_altitude_m);
    monitor.register_var("flight_demo.latitude_deg", &flight_lat_deg);
    monitor.register_var("flight_demo.longitude_deg", &flight_lon_deg);
    monitor.register_var("arinc.demo.word_310_ias", &arinc_word_310_ias);
    monitor.register_var("arinc.demo.word_271_alt_bcd", &arinc_word_271_alt_bcd);
    monitor.register_var("arinc.demo.word_350_status", &arinc_word_350_status);
    monitor.register_var("arinc.demo.word_204_roll", &arinc_word_204_roll);
    monitor.register_var("arinc.demo.word_206_heading", &arinc_word_206_heading);
    monitor.register_var("arinc.demo.word_320_cas", &arinc_word_320_cas);
    monitor.register_var("arinc.demo.word_310_bad_ssm", &arinc_word_310_bad_ssm);
    monitor.register_var("arinc.demo.word_350_bad_ssm", &arinc_word_350_bad_ssm);
    monitor.register_var("arinc.demo.word_204_bad_parity", &arinc_word_204_bad_parity);
    monitor.register_var("RT1_W3_ALT", &m1553_rt1_w3_alt);
    monitor.register_var("RT1_W3_IAS", &m1553_rt1_w3_ias);
    monitor.register_var("RT1_W3_HDG", &m1553_rt1_w3_hdg);
    monitor.register_var("RT2_W1_STATUS", &m1553_rt2_w1_status);
    monitor.register_var("RT3_W2_FUEL", &m1553_rt3_w2_fuel);
    monitor.register_var("RT1_W3_STATUS_WORD", &m1553_rt1_w3_status_word);
    monitor.register_var("5waves.sine", &sine_wave);
    monitor.register_var("5waves.cosine", &cosine_wave);
    monitor.register_var("5sensors.temperature", &temperature);
    monitor.register_var("5sensors.pressure", &pressure);
    monitor.register_var("5sensors.humidity", &humidity);
    monitor.register_var("5system.counter", &counter);
    monitor.register_var("5system.flag", &flag);
    monitor.register_var("5control.setpoint", &setpoint);
    monitor.register_var("5control.pid.kp", &pid_kp);
    monitor.register_var("5control.pid.ki", &pid_ki);
    monitor.register_var("5control.pid.kd", &pid_kd);
    monitor.register_var("5control.pid.output", &pid_output);
    monitor.register_var("5state.position.x", &pos_x);
    monitor.register_var("5state.position.y", &pos_y);
    monitor.register_var("5state.velocity.x", &vel_x);
    monitor.register_var("5state.velocity.y", &vel_y);
    monitor.register_var("4waves.sine", &sine_wave);
    monitor.register_var("4waves.cosine", &cosine_wave);
    monitor.register_var("4sensors.temperature", &temperature);
    monitor.register_var("4sensors.pressure", &pressure);
    monitor.register_var("4sensors.humidity", &humidity);
    monitor.register_var("4system.counter", &counter);
    monitor.register_var("4system.flag", &flag);
    monitor.register_var("4control.setpoint", &setpoint);
    monitor.register_var("4control.pid.kp", &pid_kp);
    monitor.register_var("4control.pid.ki", &pid_ki);
    monitor.register_var("4control.pid.kd", &pid_kd);
    monitor.register_var("4control.pid.output", &pid_output);
    monitor.register_var("4state.position.x", &pos_x);
    monitor.register_var("4state.position.y", &pos_y);
    monitor.register_var("4state.velocity.x", &vel_x);
    monitor.register_var("4state.velocity.y", &vel_y);
    monitor.register_var("3waves.sine", &sine_wave);
    monitor.register_var("3waves.cosine", &cosine_wave);
    monitor.register_var("3sensors.temperature", &temperature);
    monitor.register_var("3sensors.pressure", &pressure);
    monitor.register_var("3sensors.humidity", &humidity);
    monitor.register_var("3system.counter", &counter);
    monitor.register_var("3system.flag", &flag);
    monitor.register_var("3control.setpoint", &setpoint);
    monitor.register_var("3control.pid.kp", &pid_kp);
    monitor.register_var("3control.pid.ki", &pid_ki);
    monitor.register_var("3control.pid.kd", &pid_kd);
    monitor.register_var("3control.pid.output", &pid_output);
    monitor.register_var("3state.position.x", &pos_x);
    monitor.register_var("3state.position.y", &pos_y);
    monitor.register_var("3state.velocity.x", &vel_x);
    monitor.register_var("3state.velocity.y", &vel_y);
    monitor.register_var("2waves.sine", &sine_wave);
    monitor.register_var("2waves.cosine", &cosine_wave);
    monitor.register_var("2sensors.temperature", &temperature);
    monitor.register_var("2sensors.pressure", &pressure);
    monitor.register_var("2sensors.humidity", &humidity);
    monitor.register_var("2system.counter", &counter);
    monitor.register_var("2system.flag", &flag);
    monitor.register_var("2control.setpoint", &setpoint);
    monitor.register_var("2control.pid.kp", &pid_kp);
    monitor.register_var("2control.pid.ki", &pid_ki);
    monitor.register_var("2control.pid.kd", &pid_kd);
    monitor.register_var("2control.pid.output", &pid_output);
    monitor.register_var("2state.position.x", &pos_x);
    monitor.register_var("2state.position.y", &pos_y);
    monitor.register_var("2state.velocity.x", &vel_x);
    monitor.register_var("2state.velocity.y", &vel_y);
    monitor.register_var("1waves.sine", &sine_wave);
    monitor.register_var("1waves.cosine", &cosine_wave);
    monitor.register_var("1sensors.temperature", &temperature);
    monitor.register_var("1sensors.pressure", &pressure);
    monitor.register_var("1sensors.humidity", &humidity);
    monitor.register_var("1system.counter", &counter);
    monitor.register_var("1system.flag", &flag);
    monitor.register_var("1control.setpoint", &setpoint);
    monitor.register_var("1control.pid.kp", &pid_kp);
    monitor.register_var("1control.pid.ki", &pid_ki);
    monitor.register_var("1control.pid.kd", &pid_kd);
    monitor.register_var("1control.pid.output", &pid_output);
    monitor.register_var("1state.position.x", &pos_x);
    monitor.register_var("1state.position.y", &pos_y);
    monitor.register_var("1state.velocity.x", &vel_x);
    monitor.register_var("1state.velocity.y", &vel_y); 
    monitor.register_var("4waves.sine", &sine_wave);
    monitor.register_var("4waves.cosine", &cosine_wave);
    monitor.register_var("4sensors.temperature", &temperature);
    monitor.register_var("4sensors.pressure", &pressure);
    monitor.register_var("4sensors.humidity", &humidity);
    monitor.register_var("4system.counter", &counter);
    monitor.register_var("4system.flag", &flag);
    monitor.register_var("4control.setpoint", &setpoint);
    monitor.register_var("4control.pid.kp", &pid_kp);
    monitor.register_var("4control.pid.ki", &pid_ki);
    monitor.register_var("4control.pid.kd", &pid_kd);
    monitor.register_var("4control.pid.output", &pid_output);
    monitor.register_var("4state.position.x", &pos_x);
    monitor.register_var("4state.position.y", &pos_y);
    monitor.register_var("4state.velocity.x", &vel_x);
    monitor.register_var("4state.velocity.y", &vel_y);
    monitor.register_var("45waves.sine", &sine_wave);
    monitor.register_var("45waves.cosine", &cosine_wave);
    monitor.register_var("45sensors.temperature", &temperature);
    monitor.register_var("45sensors.pressure", &pressure);
    monitor.register_var("45sensors.humidity", &humidity);
    monitor.register_var("45system.counter", &counter);
    monitor.register_var("45system.flag", &flag);
    monitor.register_var("45control.setpoint", &setpoint);
    monitor.register_var("45control.pid.kp", &pid_kp);
    monitor.register_var("45control.pid.ki", &pid_ki);
    monitor.register_var("45control.pid.kd", &pid_kd);
    monitor.register_var("45control.pid.output", &pid_output);
    monitor.register_var("45state.position.x", &pos_x);
    monitor.register_var("45state.position.y", &pos_y);
    monitor.register_var("45state.velocity.x", &vel_x);
    monitor.register_var("45state.velocity.y", &vel_y);
    monitor.register_var("44waves.sine", &sine_wave);
    monitor.register_var("44waves.cosine", &cosine_wave);
    monitor.register_var("44sensors.temperature", &temperature);
    monitor.register_var("44sensors.pressure", &pressure);
    monitor.register_var("44sensors.humidity", &humidity);
    monitor.register_var("44system.counter", &counter);
    monitor.register_var("44system.flag", &flag);
    monitor.register_var("44control.setpoint", &setpoint);
    monitor.register_var("44control.pid.kp", &pid_kp);
    monitor.register_var("44control.pid.ki", &pid_ki);
    monitor.register_var("44control.pid.kd", &pid_kd);
    monitor.register_var("44control.pid.output", &pid_output);
    monitor.register_var("44state.position.x", &pos_x);
    monitor.register_var("44state.position.y", &pos_y);
    monitor.register_var("44state.velocity.x", &vel_x);
    monitor.register_var("44state.velocity.y", &vel_y);
    monitor.register_var("43waves.sine", &sine_wave);
    monitor.register_var("43waves.cosine", &cosine_wave);
    monitor.register_var("43sensors.temperature", &temperature);
    monitor.register_var("43sensors.pressure", &pressure);
    monitor.register_var("43sensors.humidity", &humidity);
    monitor.register_var("43system.counter", &counter);
    monitor.register_var("43system.flag", &flag);
    monitor.register_var("43control.setpoint", &setpoint);
    monitor.register_var("43control.pid.kp", &pid_kp);
    monitor.register_var("43control.pid.ki", &pid_ki);
    monitor.register_var("43control.pid.kd", &pid_kd);
    monitor.register_var("43control.pid.output", &pid_output);
    monitor.register_var("43state.position.x", &pos_x);
    monitor.register_var("43state.position.y", &pos_y);
    monitor.register_var("43state.velocity.x", &vel_x);
    monitor.register_var("43state.velocity.y", &vel_y);
    monitor.register_var("42waves.sine", &sine_wave);
    monitor.register_var("42waves.cosine", &cosine_wave);
    monitor.register_var("42sensors.temperature", &temperature);
    monitor.register_var("42sensors.pressure", &pressure);
    monitor.register_var("42sensors.humidity", &humidity);
    monitor.register_var("42system.counter", &counter);
    monitor.register_var("42system.flag", &flag);
    monitor.register_var("42control.setpoint", &setpoint);
    monitor.register_var("42control.pid.kp", &pid_kp);
    monitor.register_var("42control.pid.ki", &pid_ki);
    monitor.register_var("42control.pid.kd", &pid_kd);
    monitor.register_var("42control.pid.output", &pid_output);
    monitor.register_var("42state.position.x", &pos_x);
    monitor.register_var("42state.position.y", &pos_y);
    monitor.register_var("42state.velocity.x", &vel_x);
    monitor.register_var("42state.velocity.y", &vel_y);
    monitor.register_var("41waves.sine", &sine_wave);
    monitor.register_var("41waves.cosine", &cosine_wave);
    monitor.register_var("41sensors.temperature", &temperature);
    monitor.register_var("41sensors.pressure", &pressure);
    monitor.register_var("41sensors.humidity", &humidity);
    monitor.register_var("41system.counter", &counter);
    monitor.register_var("41system.flag", &flag);
    monitor.register_var("41control.setpoint", &setpoint);
    monitor.register_var("41control.pid.kp", &pid_kp);
    monitor.register_var("41control.pid.ki", &pid_ki);
    monitor.register_var("41control.pid.kd", &pid_kd);
    monitor.register_var("41control.pid.output", &pid_output);
    monitor.register_var("41state.position.x", &pos_x);
    monitor.register_var("41state.position.y", &pos_y);
    monitor.register_var("41state.velocity.x", &vel_x);
    monitor.register_var("41state.velocity.y", &vel_y); 
    monitor.register_var("3waves.sine", &sine_wave);
    monitor.register_var("3waves.cosine", &cosine_wave);
    monitor.register_var("3sensors.temperature", &temperature);
    monitor.register_var("3sensors.pressure", &pressure);
    monitor.register_var("3sensors.humidity", &humidity);
    monitor.register_var("3system.counter", &counter);
    monitor.register_var("3system.flag", &flag);
    monitor.register_var("3control.setpoint", &setpoint);
    monitor.register_var("3control.pid.kp", &pid_kp);
    monitor.register_var("3control.pid.ki", &pid_ki);
    monitor.register_var("3control.pid.kd", &pid_kd);
    monitor.register_var("3control.pid.output", &pid_output);
    monitor.register_var("3state.position.x", &pos_x);
    monitor.register_var("3state.position.y", &pos_y);
    monitor.register_var("3state.velocity.x", &vel_x);
    monitor.register_var("3state.velocity.y", &vel_y);
    monitor.register_var("35waves.sine", &sine_wave);
    monitor.register_var("35waves.cosine", &cosine_wave);
    monitor.register_var("35sensors.temperature", &temperature);
    monitor.register_var("35sensors.pressure", &pressure);
    monitor.register_var("35sensors.humidity", &humidity);
    monitor.register_var("35system.counter", &counter);
    monitor.register_var("35system.flag", &flag);
    monitor.register_var("35control.setpoint", &setpoint);
    monitor.register_var("35control.pid.kp", &pid_kp);
    monitor.register_var("35control.pid.ki", &pid_ki);
    monitor.register_var("35control.pid.kd", &pid_kd);
    monitor.register_var("35control.pid.output", &pid_output);
    monitor.register_var("35state.position.x", &pos_x);
    monitor.register_var("35state.position.y", &pos_y);
    monitor.register_var("35state.velocity.x", &vel_x);
    monitor.register_var("35state.velocity.y", &vel_y);
    monitor.register_var("34waves.sine", &sine_wave);
    monitor.register_var("34waves.cosine", &cosine_wave);
    monitor.register_var("34sensors.temperature", &temperature);
    monitor.register_var("34sensors.pressure", &pressure);
    monitor.register_var("34sensors.humidity", &humidity);
    monitor.register_var("34system.counter", &counter);
    monitor.register_var("34system.flag", &flag);
    monitor.register_var("34control.setpoint", &setpoint);
    monitor.register_var("34control.pid.kp", &pid_kp);
    monitor.register_var("34control.pid.ki", &pid_ki);
    monitor.register_var("34control.pid.kd", &pid_kd);
    monitor.register_var("34control.pid.output", &pid_output);
    monitor.register_var("34state.position.x", &pos_x);
    monitor.register_var("34state.position.y", &pos_y);
    monitor.register_var("34state.velocity.x", &vel_x);
    monitor.register_var("34state.velocity.y", &vel_y);
    monitor.register_var("33waves.sine", &sine_wave);
    monitor.register_var("33waves.cosine", &cosine_wave);
    monitor.register_var("33sensors.temperature", &temperature);
    monitor.register_var("33sensors.pressure", &pressure);
    monitor.register_var("33sensors.humidity", &humidity);
    monitor.register_var("33system.counter", &counter);
    monitor.register_var("33system.flag", &flag);
    monitor.register_var("33control.setpoint", &setpoint);
    monitor.register_var("33control.pid.kp", &pid_kp);
    monitor.register_var("33control.pid.ki", &pid_ki);
    monitor.register_var("33control.pid.kd", &pid_kd);
    monitor.register_var("33control.pid.output", &pid_output);
    monitor.register_var("33state.position.x", &pos_x);
    monitor.register_var("33state.position.y", &pos_y);
    monitor.register_var("33state.velocity.x", &vel_x);
    monitor.register_var("33state.velocity.y", &vel_y);
    monitor.register_var("32waves.sine", &sine_wave);
    monitor.register_var("32waves.cosine", &cosine_wave);
    monitor.register_var("32sensors.temperature", &temperature);
    monitor.register_var("32sensors.pressure", &pressure);
    monitor.register_var("32sensors.humidity", &humidity);
    monitor.register_var("32system.counter", &counter);
    monitor.register_var("32system.flag", &flag);
    monitor.register_var("32control.setpoint", &setpoint);
    monitor.register_var("32control.pid.kp", &pid_kp);
    monitor.register_var("32control.pid.ki", &pid_ki);
    monitor.register_var("32control.pid.kd", &pid_kd);
    monitor.register_var("32control.pid.output", &pid_output);
    monitor.register_var("32state.position.x", &pos_x);
    monitor.register_var("32state.position.y", &pos_y);
    monitor.register_var("32state.velocity.x", &vel_x);
    monitor.register_var("32state.velocity.y", &vel_y);
    monitor.register_var("31waves.sine", &sine_wave);
    monitor.register_var("31waves.cosine", &cosine_wave);
    monitor.register_var("31sensors.temperature", &temperature);
    monitor.register_var("31sensors.pressure", &pressure);
    monitor.register_var("31sensors.humidity", &humidity);
    monitor.register_var("31system.counter", &counter);
    monitor.register_var("31system.flag", &flag);
    monitor.register_var("31control.setpoint", &setpoint);
    monitor.register_var("31control.pid.kp", &pid_kp);
    monitor.register_var("31control.pid.ki", &pid_ki);
    monitor.register_var("31control.pid.kd", &pid_kd);
    monitor.register_var("31control.pid.output", &pid_output);
    monitor.register_var("31state.position.x", &pos_x);
    monitor.register_var("31state.position.y", &pos_y);
    monitor.register_var("31state.velocity.x", &vel_x);
    monitor.register_var("31state.velocity.y", &vel_y);
    monitor.register_var("2waves.sine", &sine_wave);
    monitor.register_var("2waves.cosine", &cosine_wave);
    monitor.register_var("2sensors.temperature", &temperature);
    monitor.register_var("2sensors.pressure", &pressure);
    monitor.register_var("2sensors.humidity", &humidity);
    monitor.register_var("2system.counter", &counter);
    monitor.register_var("2system.flag", &flag);
    monitor.register_var("2control.setpoint", &setpoint);
    monitor.register_var("2control.pid.kp", &pid_kp);
    monitor.register_var("2control.pid.ki", &pid_ki);
    monitor.register_var("2control.pid.kd", &pid_kd);
    monitor.register_var("2control.pid.output", &pid_output);
    monitor.register_var("2state.position.x", &pos_x);
    monitor.register_var("2state.position.y", &pos_y);
    monitor.register_var("2state.velocity.x", &vel_x);
    monitor.register_var("2state.velocity.y", &vel_y);
    monitor.register_var("25waves.sine", &sine_wave);
    monitor.register_var("25waves.cosine", &cosine_wave);
    monitor.register_var("25sensors.temperature", &temperature);
    monitor.register_var("25sensors.pressure", &pressure);
    monitor.register_var("25sensors.humidity", &humidity);
    monitor.register_var("25system.counter", &counter);
    monitor.register_var("25system.flag", &flag);
    monitor.register_var("25control.setpoint", &setpoint);
    monitor.register_var("25control.pid.kp", &pid_kp);
    monitor.register_var("25control.pid.ki", &pid_ki);
    monitor.register_var("25control.pid.kd", &pid_kd);
    monitor.register_var("25control.pid.output", &pid_output);
    monitor.register_var("25state.position.x", &pos_x);
    monitor.register_var("25state.position.y", &pos_y);
    monitor.register_var("25state.velocity.x", &vel_x);
    monitor.register_var("25state.velocity.y", &vel_y);
    monitor.register_var("24waves.sine", &sine_wave);
    monitor.register_var("24waves.cosine", &cosine_wave);
    monitor.register_var("24sensors.temperature", &temperature);
    monitor.register_var("24sensors.pressure", &pressure);
    monitor.register_var("24sensors.humidity", &humidity);
    monitor.register_var("24system.counter", &counter);
    monitor.register_var("24system.flag", &flag);
    monitor.register_var("24control.setpoint", &setpoint);
    monitor.register_var("24control.pid.kp", &pid_kp);
    monitor.register_var("24control.pid.ki", &pid_ki);
    monitor.register_var("24control.pid.kd", &pid_kd);
    monitor.register_var("24control.pid.output", &pid_output);
    monitor.register_var("24state.position.x", &pos_x);
    monitor.register_var("24state.position.y", &pos_y);
    monitor.register_var("24state.velocity.x", &vel_x);
    monitor.register_var("24state.velocity.y", &vel_y);
    monitor.register_var("23waves.sine", &sine_wave);
    monitor.register_var("23waves.cosine", &cosine_wave);
    monitor.register_var("23sensors.temperature", &temperature);
    monitor.register_var("23sensors.pressure", &pressure);
    monitor.register_var("23sensors.humidity", &humidity);
    monitor.register_var("23system.counter", &counter);
    monitor.register_var("23system.flag", &flag);
    monitor.register_var("23control.setpoint", &setpoint);
    monitor.register_var("23control.pid.kp", &pid_kp);
    monitor.register_var("23control.pid.ki", &pid_ki);
    monitor.register_var("23control.pid.kd", &pid_kd);
    monitor.register_var("23control.pid.output", &pid_output);
    monitor.register_var("23state.position.x", &pos_x);
    monitor.register_var("23state.position.y", &pos_y);
    monitor.register_var("23state.velocity.x", &vel_x);
    monitor.register_var("23state.velocity.y", &vel_y);
    monitor.register_var("22waves.sine", &sine_wave);
    monitor.register_var("22waves.cosine", &cosine_wave);
    monitor.register_var("22sensors.temperature", &temperature);
    monitor.register_var("22sensors.pressure", &pressure);
    monitor.register_var("22sensors.humidity", &humidity);
    monitor.register_var("22system.counter", &counter);
    monitor.register_var("22system.flag", &flag);
    monitor.register_var("22control.setpoint", &setpoint);
    monitor.register_var("22control.pid.kp", &pid_kp);
    monitor.register_var("22control.pid.ki", &pid_ki);
    monitor.register_var("22control.pid.kd", &pid_kd);
    monitor.register_var("22control.pid.output", &pid_output);
    monitor.register_var("22state.position.x", &pos_x);
    monitor.register_var("22state.position.y", &pos_y);
    monitor.register_var("22state.velocity.x", &vel_x);
    monitor.register_var("22state.velocity.y", &vel_y);
    monitor.register_var("21waves.sine", &sine_wave);
    monitor.register_var("21waves.cosine", &cosine_wave);
    monitor.register_var("21sensors.temperature", &temperature);
    monitor.register_var("21sensors.pressure", &pressure);
    monitor.register_var("21sensors.humidity", &humidity);
    monitor.register_var("21system.counter", &counter);
    monitor.register_var("21system.flag", &flag);
    monitor.register_var("21control.setpoint", &setpoint);
    monitor.register_var("21control.pid.kp", &pid_kp);
    monitor.register_var("21control.pid.ki", &pid_ki);
    monitor.register_var("21control.pid.kd", &pid_kd);
    monitor.register_var("21control.pid.output", &pid_output);
    monitor.register_var("21state.position.x", &pos_x);
    monitor.register_var("21state.position.y", &pos_y);
    monitor.register_var("21state.velocity.x", &vel_x);
    monitor.register_var("21state.velocity.y", &vel_y);
    monitor.register_var("1waves.sine", &sine_wave);
    monitor.register_var("1waves.cosine", &cosine_wave);
    monitor.register_var("1sensors.temperature", &temperature);
    monitor.register_var("1sensors.pressure", &pressure);
    monitor.register_var("1sensors.humidity", &humidity);
    monitor.register_var("1system.counter", &counter);
    monitor.register_var("1system.flag", &flag);
    monitor.register_var("1control.setpoint", &setpoint);
    monitor.register_var("1control.pid.kp", &pid_kp);
    monitor.register_var("1control.pid.ki", &pid_ki);
    monitor.register_var("1control.pid.kd", &pid_kd);
    monitor.register_var("1control.pid.output", &pid_output);
    monitor.register_var("1state.position.x", &pos_x);
    monitor.register_var("1state.position.y", &pos_y);
    monitor.register_var("1state.velocity.x", &vel_x);
    monitor.register_var("1state.velocity.y", &vel_y);
    monitor.register_var("15waves.sine", &sine_wave);
    monitor.register_var("15waves.cosine", &cosine_wave);
    monitor.register_var("15sensors.temperature", &temperature);
    monitor.register_var("15sensors.pressure", &pressure);
    monitor.register_var("15sensors.humidity", &humidity);
    monitor.register_var("15system.counter", &counter);
    monitor.register_var("15system.flag", &flag);
    monitor.register_var("15control.setpoint", &setpoint);
    monitor.register_var("15control.pid.kp", &pid_kp);
    monitor.register_var("15control.pid.ki", &pid_ki);
    monitor.register_var("15control.pid.kd", &pid_kd);
    monitor.register_var("15control.pid.output", &pid_output);
    monitor.register_var("15state.position.x", &pos_x);
    monitor.register_var("15state.position.y", &pos_y);
    monitor.register_var("15state.velocity.x", &vel_x);
    monitor.register_var("15state.velocity.y", &vel_y);
    monitor.register_var("14waves.sine", &sine_wave);
    monitor.register_var("14waves.cosine", &cosine_wave);
    monitor.register_var("14sensors.temperature", &temperature);
    monitor.register_var("14sensors.pressure", &pressure);
    monitor.register_var("14sensors.humidity", &humidity);
    monitor.register_var("14system.counter", &counter);
    monitor.register_var("14system.flag", &flag);
    monitor.register_var("14control.setpoint", &setpoint);
    monitor.register_var("14control.pid.kp", &pid_kp);
    monitor.register_var("14control.pid.ki", &pid_ki);
    monitor.register_var("14control.pid.kd", &pid_kd);
    monitor.register_var("14control.pid.output", &pid_output);
    monitor.register_var("14state.position.x", &pos_x);
    monitor.register_var("14state.position.y", &pos_y);
    monitor.register_var("14state.velocity.x", &vel_x);
    monitor.register_var("14state.velocity.y", &vel_y);
    monitor.register_var("13waves.sine", &sine_wave);
    monitor.register_var("13waves.cosine", &cosine_wave);
    monitor.register_var("13sensors.temperature", &temperature);
    monitor.register_var("13sensors.pressure", &pressure);
    monitor.register_var("13sensors.humidity", &humidity);
    monitor.register_var("13system.counter", &counter);
    monitor.register_var("13system.flag", &flag);
    monitor.register_var("13control.setpoint", &setpoint);
    monitor.register_var("13control.pid.kp", &pid_kp);
    monitor.register_var("13control.pid.ki", &pid_ki);
    monitor.register_var("13control.pid.kd", &pid_kd);
    monitor.register_var("13control.pid.output", &pid_output);
    monitor.register_var("13state.position.x", &pos_x);
    monitor.register_var("13state.position.y", &pos_y);
    monitor.register_var("13state.velocity.x", &vel_x);
    monitor.register_var("13state.velocity.y", &vel_y);
    monitor.register_var("12waves.sine", &sine_wave);
    monitor.register_var("12waves.cosine", &cosine_wave);
    monitor.register_var("12sensors.temperature", &temperature);
    monitor.register_var("12sensors.pressure", &pressure);
    monitor.register_var("12sensors.humidity", &humidity);
    monitor.register_var("12system.counter", &counter);
    monitor.register_var("12system.flag", &flag);
    monitor.register_var("12control.setpoint", &setpoint);
    monitor.register_var("12control.pid.kp", &pid_kp);
    monitor.register_var("12control.pid.ki", &pid_ki);
    monitor.register_var("12control.pid.kd", &pid_kd);
    monitor.register_var("12control.pid.output", &pid_output);
    monitor.register_var("12state.position.x", &pos_x);
    monitor.register_var("12state.position.y", &pos_y);
    monitor.register_var("12state.velocity.x", &vel_x);
    monitor.register_var("12state.velocity.y", &vel_y);
    monitor.register_var("11waves.sine", &sine_wave);
    monitor.register_var("11waves.cosine", &cosine_wave);
    monitor.register_var("11sensors.temperature", &temperature);
    monitor.register_var("11sensors.pressure", &pressure);
    monitor.register_var("11sensors.humidity", &humidity);
    monitor.register_var("11system.counter", &counter);
    monitor.register_var("11system.flag", &flag);
    monitor.register_var("11control.setpoint", &setpoint);
    monitor.register_var("11control.pid.kp", &pid_kp);
    monitor.register_var("11control.pid.ki", &pid_ki);
    monitor.register_var("11control.pid.kd", &pid_kd);
    monitor.register_var("11control.pid.output", &pid_output);
    monitor.register_var("11state.position.x", &pos_x);
    monitor.register_var("11state.position.y", &pos_y);
    monitor.register_var("11state.velocity.x", &vel_x);
    monitor.register_var("lorenzo", &vel_y);


    for (int i = 0; i < 5000; i++) {
        std::string name = "test" + std::to_string(i);
        monitor.register_var(name, &vel_y);
    }
    // Lectura + escritura: puntero a array C
    monitor.register_array("arrays.spectrum", spectrum, 32);

    // Lectura + escritura: vector con mutex
    monitor.register_array("arrays.sensor_bank", sensor_bank, sensor_bank_mtx);

    // Solo lectura: getter custom (devuelve copia, el monitor NO puede escribir)
    monitor.register_array("arrays.readonly_buf", [&]() -> std::vector<double> {
        std::lock_guard<std::mutex> lk(internal_mtx);
        return std::vector<double>(internal_buf, internal_buf + 16);
    });

    if (!monitor.start(10)) {
        std::cerr << "Error al iniciar VarMonitor\n";
        return 1;
    }

    std::cout << "=== Demo Server iniciado (variables + arrays; ARINC429 + MIL-STD-1553 RT_W_*; SSM/paridad ARINC erroneos) ===\n";
    std::cout << "Presiona Ctrl+C para salir\n\n";

    std::mt19937 rng(42);
    std::normal_distribution<double> noise(0.0, 0.5);
    double t = 0.0;

    while (g_running) {
        sine_wave = std::sin(t);
        cosine_wave = std::cos(t);
        temperature = 20.0 + 5.0 * std::sin(t * 0.1) + noise(rng);
        pressure = 1013.25 + 2.0 * std::sin(t * 0.05) + noise(rng) * 0.3;
        humidity = 45.0 + 10.0 * std::sin(t * 0.03) + noise(rng) * 0.5;
        counter++;
        flag = (counter % 20) < 10;
        pid_output = pid_kp * sine_wave + pid_ki * t * 0.001 + pid_kd * cosine_wave;
        pos_x = 10.0 * std::sin(t * 0.2);
        pos_y = 10.0 * std::cos(t * 0.2);
        vel_x = 2.0 * std::cos(t * 0.2);
        vel_y = -2.0 * std::sin(t * 0.2);

        flight_roll_deg = 22.0 * std::sin(t * 0.38);
        flight_pitch_deg = 12.0 * std::sin(t * 0.31);
        flight_yaw_deg = 30.0 * std::sin(t * 0.22);
        flight_vx_body = 42.0 + 14.0 * std::sin(t * 0.21);
        body_vel_to_ned(flight_roll_deg, flight_pitch_deg, flight_yaw_deg, flight_vx_body, 0.0, 0.0, &flight_vn_ned,
                        &flight_ve_ned, &flight_vd_ned);
        /* NED: D positivo abajo; altitud = −D ⇒ d(alt)/dt = −Vd. Mismo paso que t += 0.01. */
        flight_pos_d_ned += flight_vd_ned * 0.01;
        flight_altitude_m = -flight_pos_d_ned;
        {
            const double R_earth = 6378137.0;
            const double dt = 0.01;
            flight_lat_rad += (flight_vn_ned * dt) / R_earth;
            flight_lon_rad += (flight_ve_ned * dt) / (R_earth * std::cos(flight_lat_rad));
            flight_lat_deg = flight_lat_rad * 180.0 / 3.14159265358979323846;
            flight_lon_deg = flight_lon_rad * 180.0 / 3.14159265358979323846;
        }

        // Se?ales f?sicas demo para labels de CSV importables.
        const double ias_kt = 220.0 + 45.0 * std::sin(t * 0.25);          // label 310 (scale 1)
        const double alt_bcd_ft = 3200.0 + 400.0 * std::sin(t * 0.06);    // label 271 (BCD)
        const double roll_deg = 15.0 * std::sin(t * 0.45);                // label 204 (scale 0.01)
        const double hdg_deg = std::fmod((t * 12.0), 360.0);              // label 206 (scale 0.01)
        const double cas_kt = 180.0 + 30.0 * std::sin(t * 0.18);          // label 320 (scale 0.0625)
        uint32_t status_bits = 0u;                                         // label 350 (DIS)
        const bool on_ground = std::sin(t * 0.03) < -0.5;
        const bool in_flight = !on_ground;
        const bool overspeed = cas_kt > 205.0;
        const bool maint_req = (counter % 400) > 350;
        if (on_ground) status_bits |= (1u << 0);  // ON_GROUND / GEAR_NOSE_DOWN
        if (in_flight) status_bits |= (1u << 1);  // IN_FLIGHT / GEAR_LEFT_DOWN
        if (overspeed) status_bits |= (1u << 2);  // OVERSPEED_WARN / GEAR_RIGHT_DOWN
        if (maint_req) status_bits |= (1u << 3);  // MAINT_REQ / GEAR_LOCKED
        if (on_ground) status_bits |= (1u << 4);  // WOW_MAIN (csv discrete bits sample)

        // label_dec: 310(oct)=200, 271(oct)=185, 350(oct)=232, 204(oct)=132, 206(oct)=134, 320(oct)=208
        arinc_word_310_ias = make_arinc429_word(200u, encode_bnr_unsigned(ias_kt), 3u, 0u);
        arinc_word_271_alt_bcd = make_arinc429_word(185u, encode_bcd_4digits(static_cast<unsigned>(std::lround(alt_bcd_ft))), 3u, 0u);
        arinc_word_350_status = make_arinc429_word(232u, status_bits, 0u, 0u);
        arinc_word_204_roll = make_arinc429_word(132u, encode_bnr_signed(roll_deg / 0.01), 3u, 0u);
        arinc_word_206_heading = make_arinc429_word(134u, encode_bnr_unsigned(hdg_deg / 0.01), 3u, 0u);
        arinc_word_320_cas = make_arinc429_word(208u, encode_bnr_unsigned(cas_kt / 0.0625), 3u, 0u);

        // Errores demo: SSM inv?lido (BNR?3, DIS?0) o paridad mala (mismo dato f?sico que las buenas).
        arinc_word_310_bad_ssm = make_arinc429_word(200u, encode_bnr_unsigned(ias_kt), 0u, 0u);   // SSM=0 no v?lido para BNR por defecto
        arinc_word_350_bad_ssm = make_arinc429_word(232u, status_bits, 3u, 0u);                      // SSM?0 no v?lido para DIS
        arinc_word_204_bad_parity = force_bad_odd_parity(
            make_arinc429_word(132u, encode_bnr_signed(roll_deg / 0.01), 3u, 0u));

        // MIL-STD-1553: palabra de carga (16 bits t?picos; mismo criterio que m1553_labels_import.json).
        const double alt_ft_m1553 = 3500.0 + 200.0 * std::sin(t * 0.07);
        m1553_rt1_w3_alt = static_cast<uint32_t>(std::lround(alt_ft_m1553 / 0.1)) & 0xFFFFu;
        m1553_rt1_w3_ias = static_cast<uint32_t>(std::lround(ias_kt / 0.25)) & 0xFFFFu;
        m1553_rt1_w3_hdg = static_cast<uint32_t>(std::lround(hdg_deg / 0.01)) & 0xFFFFu;
        m1553_rt2_w1_status = static_cast<uint32_t>(status_bits & 0xFFFFu);
        const double fuel_kg = 4000.0 + 150.0 * std::sin(t * 0.04);
        m1553_rt3_w2_fuel = static_cast<uint32_t>(std::lround(fuel_kg / 0.5)) & 0xFFFFu;
        // Carga 16b de ejemplo para palabra empaquetada (bits MSB 1?16): variaci�n lenta para ver subcampos en el monitor.
        m1553_rt1_w3_status_word =
            (static_cast<uint32_t>(std::lround(7.0 + 3.0 * std::sin(t * 0.11)) & 0xFu) << 12u) |
            (1u << 11u) |
            (static_cast<uint32_t>(std::lround(500.0 + 100.0 * std::cos(t * 0.09)) & 0x3FFu) << 1u);

        for (int i = 0; i < 4; i++)
            spectrum[i] = std::sin(t * (i + 1) * 0.3) * (32 - i) / 32.0;

        {
            std::lock_guard<std::mutex> lock(sensor_bank_mtx);
            for (size_t i = 0; i < sensor_bank.size(); i++)
                sensor_bank[i] = 10.0 + 3.0 * std::sin(t * 0.5 + i * 0.8) + noise(rng) * 0.2;
        }

        {
            std::lock_guard<std::mutex> lk(internal_mtx);
            for (int i = 0; i < 16; i++)
                internal_buf[i] = std::cos(t * 0.4 + i * 0.5) * 5.0;
        }

        t += 0.01;
        monitor.write_shm_snapshot(); /* Publicar snapshot en SHM para lectores (ej. Python) */
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    monitor.stop();
    std::cout << "\nDemo Server detenido.\n";
    return 0;
}
