#include "var_monitor.hpp"
#include <iostream>
#include <cmath>
#include <csignal>
#include <atomic>
#include <thread>
#include <chrono>
#include <random>
#include <mutex>

static std::atomic<bool> g_running{true};

void signal_handler(int) { g_running = false; }

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

    // Array estático: lectura Y escritura por indice desde el monitor
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

    // Lectura + escritura: puntero a array C
    monitor.register_array("arrays.spectrum", spectrum, 32);

    // Lectura + escritura: vector con mutex
    monitor.register_array("arrays.sensor_bank", sensor_bank, sensor_bank_mtx);

    // Solo lectura: getter custom (devuelve copia, el monitor NO puede escribir)
    monitor.register_array("arrays.readonly_buf", [&]() -> std::vector<double> {
        std::lock_guard<std::mutex> lk(internal_mtx);
        return std::vector<double>(internal_buf, internal_buf + 16);
    });

    if (!monitor.start(100)) {
        std::cerr << "Error al iniciar VarMonitor\n";
        return 1;
    }

    std::cout << "=== Demo Server iniciado (16 escalares + 3 arrays) ===\n";
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

        t += 0.1;
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    monitor.stop();
    std::cout << "\nDemo Server detenido.\n";
    return 0;
}
