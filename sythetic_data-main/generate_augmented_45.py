import os
import glob
import pandas as pd
import numpy as np

def augment_file(real_filepath, output_dir, n_samples=20):
    df_orig = pd.read_csv(real_filepath)
    
    # Filter to only the events we care about (remove recovery)
    # Based on your context: Ambient for baseline, BreathSample, and FeNOWindow/FeNOMeasurement for the gas.
    valid_events = ['AmbientSamplingRFC', 'BreathSampleCollection', 'FeNOWindow', 'FeNOMeasurement']
    df = df_orig[df_orig['event_name'].isin(valid_events)].copy()
    
    base_name = os.path.basename(real_filepath).replace('.csv', '')
    
    if len(df) == 0:
        print(f"Skipping {base_name} (Filtered {len(df_orig)} -> 0 rows)")
        return
        
    sensor_cols = [f"{chr(r)}{c}" for r in range(65, 73) for c in range(1, 9)]
    
    print(f"Augmenting {n_samples} variations for: {base_name} (Filtered {len(df_orig)} -> {len(df)} rows)")
        
    for i in range(n_samples):
        synth_df = df.copy()
        
        for col in sensor_cols:
            real_curve = df[col].values
            
            # Baseline is calculated exactly from the 'AmbientSamplingRFC' period
            ambient_data = df[df['event_name'] == 'AmbientSamplingRFC'][col].values
            
            if len(ambient_data) > 0:
                R_base = ambient_data.mean()
            else:
                R_base = real_curve[:50].mean() # Fallback if no ambient found
                
            # The exact shape of the curve minus its baseline
            response_shape = real_curve - R_base
            
            # 1. Scale the baseline by a tiny margin (+/- 2%)
            synth_base = R_base * np.random.normal(1.0, 0.02)
            
            # 2. Scale the response (the spike) by a larger margin (+/- 10%)
            synth_response = response_shape * np.random.normal(1.0, 0.10)
            
            # 3. Add small synthetic static/noise based on the sensor's baseline size
            noise = np.random.normal(0, abs(R_base) * 0.001, len(real_curve))
            
            # Reconstruct the augmented curve perfectly matching original timing
            synth_curve = synth_base + synth_response + noise
            
            synth_df[col] = synth_curve
            
        out_file = os.path.join(output_dir, f"{base_name}_synth_{i+1:03d}.csv")
        synth_df.to_csv(out_file, index=False)

if __name__ == '__main__':
    input_dir = '45'
    output_dir = 'SynthAug-45'
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
        augment_file(file_path, output_dir, n_samples=100)
        
    print(f"\nDone! Generated EXACT shape-matched augmented datasets in: '{output_dir}'")
