import os
import glob
import pandas as pd
import numpy as np

# ==========================================
# CONFIGURATION VARIABLES
# ==========================================
INPUT_DIR = '45'                     # Directory containing original CSV files
OUTPUT_DIR = 'SynthAug-45'           # Directory to save generated synthetic data
N_SAMPLES = 20                       # Number of synthetic samples to generate per unique file
BASELINE_VARIANCE_PCT = 2.0          # ± Percentage variance applied to the baseline
RESPONSE_VARIANCE_PCT = 10.0         # ± Percentage variance applied to the response magnitude
NOISE_PCT = 0.1                      # Percentage of baseline used to scale the random noise
# ==========================================


def generate_synthetic_data():
    if not os.path.exists(INPUT_DIR):
        print(f"Error: Input directory '{INPUT_DIR}' not found.")
        return

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    files = glob.glob(os.path.join(INPUT_DIR, '*.csv'))
    
    if not files:
        print(f"No CSV files found in '{INPUT_DIR}'.")
        return

    # Group by concentration to prevent duplicating similar files
    # Example filename: ABGv5MUXOff-0ppb-3AH...
    conc_files = {}
    for f in files:
        parts = os.path.basename(f).split('-')
        if len(parts) > 2:
            conc = parts[1]  # Extracting concentration (e.g., '0ppb', '10ppb')
            if conc not in conc_files:
                conc_files[conc] = f
    
    files_to_process = list(conc_files.values()) if conc_files else files
    print(f"Found {len(files_to_process)} distinct source files to process in '{INPUT_DIR}'.\n")

    # Convert percentages to decimals for the math
    base_var = BASELINE_VARIANCE_PCT / 100.0
    resp_var = RESPONSE_VARIANCE_PCT / 100.0
    noise_fac = NOISE_PCT / 100.0

    for file_path in files_to_process:
        df = pd.read_csv(file_path)
        sensor_cols = [f"{chr(r)}{c}" for r in range(65, 73) for c in range(1, 9)]
        base_name = os.path.basename(file_path).replace('.csv', '')
        
        print(f"Generating {N_SAMPLES} samples for: {base_name[:45]}...")

        for i in range(N_SAMPLES):
            synth_df = df.copy()

            for col in sensor_cols:
                if col not in df.columns:
                    continue
                    
                real_curve = df[col].values
                
                # 1. Find the Baseline (average of the first ~50 points)
                baseline_len = min(50, max(1, len(real_curve) // 5))
                R_base = real_curve[:baseline_len].mean()
                
                # 2. Extract the exact shape of the response curve
                response_shape = real_curve - R_base
                
                # 3. Apply the tuning parameters using Random Normal Distribution
                synth_base = R_base * np.random.normal(1.0, base_var)
                synth_response = response_shape * np.random.normal(1.0, resp_var)
                
                # 4. Generate subtle high-frequency noise
                noise = np.random.normal(0, max(0.1, abs(R_base) * noise_fac), len(real_curve))
                
                # 5. Recombine into the final synthetic curve preserving the original shape
                synth_df[col] = synth_base + synth_response + noise

            # Save the new synthetic CSV file
            out_file = os.path.join(OUTPUT_DIR, f"{base_name}_synth_{i+1:02d}.csv")
            synth_df.to_csv(out_file, index=False)
            
    print(f"\nDone! Successfully generated {len(files_to_process) * N_SAMPLES} total synthetic files in '{OUTPUT_DIR}'.")

if __name__ == '__main__':
    generate_synthetic_data()
