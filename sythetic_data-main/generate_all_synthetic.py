import os
import glob
import pandas as pd
import numpy as np

def augment_file(real_filepath, output_dir, n_samples=5):
    df_orig = pd.read_csv(real_filepath)
    
    # Filter to only the target gas events and ambient baseline (remove recovery)
    valid_events = ['AmbientSamplingRFC', 'BreathSampleCollection', 'FeNOWindow', 'FeNOMeasurement']
    df = df_orig[df_orig['event_name'].isin(valid_events)].copy()
    
    if len(df) == 0:
        return
        
    sensor_cols = [f"{chr(r)}{c}" for r in range(65, 73) for c in range(1, 9)]
    base_name = os.path.basename(real_filepath).replace('.csv', '')
        
    for i in range(n_samples):
        synth_df = df.copy()
        
        for col in sensor_cols:
            if col not in df.columns:
                continue
                
            real_curve = df[col].values
            
            # Baseline is calculated exactly from the 'AmbientSamplingRFC' period
            ambient_data = df[df['event_name'] == 'AmbientSamplingRFC'][col].values
            
            if len(ambient_data) > 0:
                R_base = ambient_data.mean()
            else:
                R_base = real_curve[:50].mean() if len(real_curve) > 50 else real_curve.mean()
                
            # The exact shape of the curve minus its baseline
            response_shape = real_curve - R_base
            
            # 1. Scale the baseline by a tiny margin (+/- 2%)
            synth_base = R_base * np.random.normal(1.0, 0.02)
            
            # 2. Scale the response (the spike) by a larger margin (+/- 10%)
            synth_response = response_shape * np.random.normal(1.0, 0.10)
            
            # 3. Add small synthetic static/noise based on the sensor's baseline size
            noise = np.random.normal(0, max(0.1, abs(R_base) * 0.001), len(real_curve))
            
            # Reconstruct the augmented curve perfectly matching original timing
            synth_curve = synth_base + synth_response + noise
            
            synth_df[col] = synth_curve
            
        out_file = os.path.join(output_dir, f"{base_name}_synth_{i+1:02d}.csv")
        synth_df.to_csv(out_file, index=False)

if __name__ == '__main__':
    # Process both device folders
    for folder in ['45', '54']:
        if not os.path.exists(folder):
            continue
            
        output_dir = f'Synth-{folder}'
        os.makedirs(output_dir, exist_ok=True)
        
        files = glob.glob(os.path.join(folder, '*.csv'))
        print(f"Processing folder '{folder}' ({len(files)} original files)... generating 5 synthetic clones each.")
        
        for file_path in files:
            # Generate 5 synthetic versions for EVERY single real file to maximize dataset size
            augment_file(file_path, output_dir, n_samples=5)
            
    print(f"\nDone! Completely finished generating synthetic datasets for all devices.")
