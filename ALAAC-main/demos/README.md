# CURATION CONFIG OPTIONS

- dataset_options
    - curated_filename: True/False, use ordering within filename instead of regex
    - paths
        - clear_paths: true/false, delete old plots/outputs
        - raw_data: path to raw_data
    - timestamp_column_name: name of column with timestamps
    - dataset_name: (not used)
    - event_column_name: name of column with events
    - sampling_rates: keys are device_ids, values are sampling rate
        - "default": 1.0 -- fallback sampling rate
    - device_id_columns: list of values that contain names of columns with 'device_id'

- prep_pipeline
    - rename_columns: rename columns in dataframe
    - filter_signal
      - 
        - method: lowpass
            - order
            - cut_off_hz
        - method: rolling_median, rolling_mean
            - window_size

    - normalize_signals:
        - method : "baseline"
        - sensing_elements
        - save_output: true/false
        - start_end_indices: [start_index, end_index(exposure start)] (optional)

- analysis_pipeline
    - monotonic_average_plots