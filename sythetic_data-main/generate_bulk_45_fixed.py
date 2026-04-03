import os
import glob
import pandas as pd
import numpy as np

def sensor_response_model(t, R_base, delta_R, tau):
    # Prevent divide by zero or negative tau, which causes exponential explosion (Inf)
    tau = max(1.0, tau)
    return R_base + delta_R * (1.0 - np.exp(-t / tau))

def augment_file(real_filepath, output_dir, n_samples=20):
    df = pd.read_csv(real_filepath)
    sensor_cols = [f"{chr(r)}{c}" for r in range(65, 73) for c in range(1, 9)]
    
    time_array = np.arange(len(df))
    
    # Extract parameters for all 64 channels
    real_params = {}
    for col in sensor_cols:
        real_curve = df[col].values
        R_base_real = real_curve[:10].mean()
        delta_R_real = real_curve[-20:].mean() - R_base_real
        target_val = R_base_real + 0.632 * delta_R_real
        
        try:
            diffs = np.abs(real_curve - target_val)
            tau_real = float(max(1, np.where(diffs == np.min(diffs))[0][0]))
        except:
            tau_real = 50.0
            
        real_params[col] = (R_base_real, delta_R_real, tau_real)
        
    base_name = os.path.basename(real_filepath).replace('.csv', '')
    print(f"Fixing and Generating {n_samples} variations for: {base_name}")
        
    for i in range(n_samples):
        # By taking df.copy(), we preserve all 126 columns in their EXACT original order, 
        # including all metadata columns like event_name, configuration_id, FLW0_, ANLT0_, etc.
        synth_df = df.copy() 
        
        for col in sensor_cols:
            R_base_real, delta_R_real, tau_real = real_params[col]
            
            # Apply reasonable variances
            # e.g., baseline varies by 2%, response by 5%, tau by 10%
            R_base_synth = R_base_real * np.random.normal(1.0, 0.02)
            delta_R_synth = delta_R_real * np.random.normal(1.0, 0.05)
            # Ensure time constant is strictly positive
            tau_synth = max(1.0, float(tau_real) * np.random.normal(1.0, 0.1))
            
            # Generate mathematically smooth curve
            clean_curve = sensor_response_model(time_array, R_base_synth, delta_R_synth, tau_synth)
            
            # Add small realistic sensor noise (0.1% of baseline)
            noise = np.random.normal(0, max(0.1, abs(R_base_real) * 0.001), len(time_array))
            
            synth_df[col] = clean_curve + noise
            
        out_file = os.path.join(output_dir, f"{base_name}_synth_{i+1:02d}.csv")
        synth_df.to_csv(out_file, index=False)

if __name__ == '__main__':
    input_dir = '45'
    output_dir = 'Synth-45'
    os.makedirs(output_dir, exist_ok=True)
    
    files = glob.glob(os.path.join(input_dir, '*.csv'))
    
    conc_files = {}
    for f in files:
        parts = os.path.basename(f).split('-')
        if len(parts) > 2:
            conc = parts[1]
            if conc not in conc_files:
                conc_files[conc] = f
                
    for conc, file_path in conc_files.items():
        augment_file(file_path, output_dir, n_samples=20)
        
    print(f"\nDone! Regenerated accurate datasets in: '{output_dir}'")
