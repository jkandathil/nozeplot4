import csv
import math
import random
import os

# Create directory to store the test files
os.makedirs("ml_test_data", exist_ok=True)

def generate_sensor_data(filename, concentration, is_gas_a=True):
    # Base params
    baseline = 1.0 + random.uniform(-0.1, 0.1)
    noise_level = 0.02
    
    # Peak params (Gas A vs Gas B have different shapes)
    peak_time = 50 + random.uniform(-2, 2)
    peak_width = 15 if is_gas_a else 30
    peak_height = concentration * (0.5 if is_gas_a else 0.8) + random.uniform(-0.05, 0.05)
    
    with open(f"ml_test_data/{filename}", 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['Time', 'SensorVoltage'])
        
        for t in range(200):
            # Base signal
            signal = baseline
            
            # Add peak (Gaussian-like response)
            if t > 30: # Injection happens at t=30
                dist = t - peak_time
                signal += peak_height * math.exp(-(dist**2) / (2 * peak_width**2))
            
            # Add noise
            signal += random.gauss(0, noise_level)
            
            writer.writerow([t, round(signal, 4)])

# Generate Regression Dataset (Varying concentrations of Gas A)
concentrations = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100]
for i in range(3): # 3 replicates per concentration
    for c in concentrations:
        generate_sensor_data(f"regression_GasA_{c}ppb_rep{i+1}.csv", c, True)

# Generate Classification Dataset (Gas A vs Gas B at constant concentration)
for i in range(15):
    generate_sensor_data(f"classification_GasA_rep{i+1}.csv", 50, True)
    generate_sensor_data(f"classification_GasB_rep{i+1}.csv", 50, False)

print("Generated ML test datasets in 'ml_test_data' folder.")
