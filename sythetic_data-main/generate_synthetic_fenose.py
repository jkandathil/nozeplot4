import os
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.optimize import curve_fit

# 1. Define the Parametric Model (Approach 2)
# A typical chemiresistive response can be modeled as a baseline + exponential rise/decay
def sensor_response_model(t, R_base, delta_R, tau):
    """
    Parametric model for a sensor response to gas.
    t: time array
    R_base: baseline resistance/conductance
    delta_R: maximum response change
    tau: time constant for exponential rise
    """
    return R_base + delta_R * (1 - np.exp(-t / tau))

def load_sample_data(filepath):
    """Loads FeNose data and extracts the 64 sensor columns."""
    df = pd.read_csv(filepath)
    # Get standard sensor element columns (A1...H8)
    sensor_cols = [f"{chr(r)}{c}" for r in range(65, 73) for c in range(1, 9)]
    return df, sensor_cols

def generate_synthetic_curve(time_array, R_base, delta_R, tau, noise_std=0.01, drift_rate=0.001):
    """
    Combines Parametric base (Approach 2) with Data Augmentation (Approach 1).
    """
    # 1. Generate Parametric Base (Approach 2)
    clean_curve = sensor_response_model(time_array, R_base, delta_R, tau)
    
    # 2. Add Jitter/Gaussian Noise (Approach 1)
    noise = np.random.normal(0, noise_std * abs(R_base), len(time_array))
    
    # 3. Add Baseline Drift (Approach 1)
    # A linear drift typical of sensor degradation/warming over time
    drift = np.linspace(0, drift_rate * len(time_array), len(time_array))
    
    # Combined Synthetic Curve
    synthetic = clean_curve + noise + drift
    return synthetic

def create_synthetic_dataset(real_df, sensor_cols, n_synthetic_samples=5):
    """
    Extracts parameters from a real signal, then uses them to generate N synthetic variations.
    """
    synthetic_datasets = []
    
    # For a real run, time is implicit by row index or timestamp. We'll use row count.
    time_array = np.arange(len(real_df))
    
    for i in range(n_synthetic_samples):
        print(f"Generating synthetic sample {i+1} / {n_synthetic_samples}...")
        synth_df = pd.DataFrame()
        synth_df['Time'] = time_array
        
        for col in sensor_cols:
            real_curve = real_df[col].values
            
            # Simple parameter extraction from real curve
            R_base_real = real_curve[:10].mean() # Mean of early baseline
            # Assuming steady state reached near the end
            delta_R_real = real_curve[-20:].mean() - R_base_real
            
            # Estimate tau roughly (time to 63% of response)
            # A more robust script would use scipy.optimize.curve_fit here
            target_val = R_base_real + 0.632 * delta_R_real
            # basic estimation for tau index
            try:
                tau_real = max(1, np.where(np.abs(real_curve - target_val) == np.min(np.abs(real_curve - target_val)))[0][0])
            except:
                tau_real = 50.0 # fallback
            
            # Sample parameters around real values to create variety
            # E.g., baseline varies by 5%, delta_R by 10%, tau by 20%
            R_base_synth = np.random.normal(R_base_real, abs(R_base_real * 0.05))
            delta_R_synth = np.random.normal(delta_R_real, abs(delta_R_real * 0.10))
            tau_synth = np.random.normal(tau_real, tau_real * 0.20)
            
            synth_curve = generate_synthetic_curve(time_array, R_base_synth, delta_R_synth, tau_synth, noise_std=0.005, drift_rate=0.002)
            synth_df[col] = synth_curve
            
        synthetic_datasets.append(synth_df)
        
    return synthetic_datasets, time_array

# --- Executing the Demo ---
if __name__ == "__main__":
    # Point to a specific 50ppb response file from Device 45
    sample_file = "45/ABGv5MUXOff-50ppb-3AH-75ccm-Maxwell-Q126_14708c35_0000000045-0926-asu-nz_0000000009-1625-oms-nz_20260316-1656.csv"
    
    print(f"Loading real data from: {sample_file}")
    df_real, sensor_cols = load_sample_data(sample_file)
    
    print("Generating 5 synthetic datasets blending Parametric Modeling and Data Augmentation...")
    synthetic_dfs, time_array = create_synthetic_dataset(df_real, sensor_cols, n_synthetic_samples=5)
    
    # Plotting real vs synthetic for a single sensor (e.g., 'A1')
    sensor_to_plot = 'A1'
    
    plt.figure(figsize=(10, 6))
    plt.plot(time_array, df_real[sensor_to_plot], label="Real Sensor Curve (A1)", color="black", linewidth=2.5)
    
    colors = ['red', 'blue', 'green', 'orange', 'purple']
    for i, synth_df in enumerate(synthetic_dfs):
        plt.plot(time_array, synth_df[sensor_to_plot], label=f"Synthetic {i+1}", color=colors[i], alpha=0.7)
        
    plt.title(f"FeNose 50ppb Response - Real vs Combined Synthetic Generation ({sensor_to_plot})")
    plt.xlabel("Time / Sampling Row")
    plt.ylabel("Sensor Response")
    plt.legend()
    plt.grid(True)
    
    # Save the plot
    output_image = "Synthetic_Generation_Demo.png"
    plt.savefig(output_image)
    print(f"\nPlot saved as {output_image}")
    
    # Save first synthetic dataset
    output_csv = "synthetic_50ppb_sample_1.csv"
    synthetic_dfs[0].to_csv(output_csv, index=False)
    print(f"First synthetic dataset saved to {output_csv}")
