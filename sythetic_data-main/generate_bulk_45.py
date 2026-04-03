import os
import glob
import pandas as pd
import numpy as np

def sensor_response_model(t, R_base, delta_R, tau):
    return R_base + delta_R * (1 - np.exp(-t / tau))

def generate_synthetic_curve(time_array, R_base, delta_R, tau, noise_std=0.005, drift_rate=0.002):
    clean_curve = sensor_response_model(time_array, R_base, delta_R, tau)
    noise = np.random.normal(0, noise_std * abs(R_base), len(time_array))
    drift = np.linspace(0, drift_rate * len(time_array), len(time_array))
    return clean_curve + noise + drift

def augment_file(real_filepath, output_dir, n_samples=20):
    df = pd.read_csv(real_filepath)
    sensor_cols = [f"{chr(r)}{c}" for r in range(65, 73) for c in range(1, 9)]
    
    # Preserve metadata columns
    meta_cols = [c for c in df.columns if c not in sensor_cols]
    meta_df = df[meta_cols]
    
    time_array = np.arange(len(df))
    
    # Extract parameters for all 64 channels
    real_params = {}
    for col in sensor_cols:
        real_curve = df[col].values
        R_base_real = real_curve[:10].mean()
        delta_R_real = real_curve[-20:].mean() - R_base_real
        target_val = R_base_real + 0.632 * delta_R_real
        try:
            # Find index where curve reaches 63.2% of its max response
            tau_real = max(1, np.where(np.abs(real_curve - target_val) == np.min(np.abs(real_curve - target_val)))[0][0])
        except:
            tau_real = 50.0
        real_params[col] = (R_base_real, delta_R_real, tau_real)
        
    base_name = os.path.basename(real_filepath).replace('.csv', '')
    print(f"Generating {n_samples} variations for: {base_name}")
        
    for i in range(n_samples):
        synth_df = meta_df.copy() # Start with true metadata
        
        for col in sensor_cols:
            R_base_real, delta_R_real, tau_real = real_params[col]
            
            # Apply reasonable variances (5% base, 10% response, 20% tau)
            R_base_synth = np.random.normal(R_base_real, abs(R_base_real * 0.05))
            delta_R_synth = np.random.normal(delta_R_real, abs(delta_R_real * 0.10))
            tau_synth = np.random.normal(tau_real, tau_real * 0.20)
            
            synth_curve = generate_synthetic_curve(time_array, R_base_synth, delta_R_synth, tau_synth)
            synth_df[col] = synth_curve
            
        out_file = os.path.join(output_dir, f"{base_name}_synth_{i+1:02d}.csv")
        synth_df.to_csv(out_file, index=False)

if __name__ == '__main__':
    input_dir = '45'
    output_dir = 'Synth-45'
    os.makedirs(output_dir, exist_ok=True)
    
    # We will pick 1 representative file from EACH concentration type to generate 20 variations each
    # This prevents creating thousands of files but gives you a rich dataset representing all conditions
    files = glob.glob(os.path.join(input_dir, '*.csv'))
    
    # Group by concentration
    conc_files = {}
    for f in files:
        parts = os.path.basename(f).split('-')
        if len(parts) > 2:
            conc = parts[1]
            if conc not in conc_files:
                conc_files[conc] = f
                
    # Generate 20 variations for each unique concentration based on 1 real file
    for conc, file_path in conc_files.items():
        augment_file(file_path, output_dir, n_samples=20)
        
    print(f"\nDone! Generated variations across {len(conc_files)} concentrations in folder: '{output_dir}'")
