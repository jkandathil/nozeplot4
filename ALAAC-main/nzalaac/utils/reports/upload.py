import json
import os
from datetime import datetime

import pandas as pd
from google.cloud import storage
from google.oauth2.service_account import Credentials

from nzalaac.constants.constant_values import (
    DEFAULT_TIMESTAMP_COLUMN_NAME,
    DEFAULT_TIMESTAMP_COLUMNS,
)
from nzalaac.utils.logger import ALAACLogger

logger = ALAACLogger(__name__)


def extract_earliest_timestamp(raw_data_dir, timestamp_column_names=None):
    """
    Scan all CSV files in a directory and return the earliest timestamp found.

    This function recursively searches through `raw_data_dir` for CSV files,
    extracts the specified timestamp column, and computes the earliest valid
    timestamp across all files. Invalid or missing timestamps are ignored.

    Parameters
    ----------
    raw_data_dir : str
        Path to the directory containing raw CSV files.
    timestamp_column : str
        Name of the timestamp column to extract from each CSV file.

    Returns
    -------
    pandas.Timestamp
        The earliest timestamp found across all files.

    Raises
    ------
    ValueError
        If no valid timestamps are found in any file.
    """
    if timestamp_column_names is None:
        timestamp_column_names = DEFAULT_TIMESTAMP_COLUMNS()
    elif type(timestamp_column_names) is not list:
        timestamp_column_names = [timestamp_column_names]

    earliest = None
    for root, _, files in os.walk(raw_data_dir):
        for file in files:
            if not file.endswith(".csv"):
                continue

            path = os.path.join(root, file)
            try:
                df = pd.read_csv(path)
                filename = os.path.basename(path)
                for col_name in timestamp_column_names:
                    if col_name in df.columns:
                        break
                if col_name not in df.columns:
                    raise ValueError(
                        f"Cannot find correct 'timestamp' column in {filename}, columns tried: {timestamp_column_names}")

                df[DEFAULT_TIMESTAMP_COLUMN_NAME()] = df[col_name]
                timestamp_column = DEFAULT_TIMESTAMP_COLUMN_NAME()
                df = df.loc[:, [timestamp_column]]

            except Exception as e:
                logger.error(e)
                continue

            if timestamp_column in df.columns:
                try:
                    ts = pd.to_datetime(df[timestamp_column], errors="coerce").dropna()
                    if not ts.empty:
                        file_min = ts.min()
                        if earliest is None or file_min < earliest:
                            earliest = file_min
                except Exception:
                    continue

    if earliest is None:
        raise ValueError(
            f"No valid timestamps found in raw data directory using columns '{timestamp_column_names}'."
        )
    return earliest


def upload_outputs_to_gcs(
        outputs_dir,
        upload_bucket_name,
        computer_id,
        batchId,
        earliest_timestamp,
        credential_path=None,
        top_folder_name=None,
):
    """
    Upload all generated output files to Google Cloud Storage (GCS).

    Files inside `outputs_dir` are uploaded while preserving folder structure,
    but organized in GCS under the following naming scheme:

        bucket/computer_id/YYYYMMDD/YYYYMMDD-HH:MM-batchId/<files...>

    Parameters
    ----------
    outputs_dir : str
        Path to the local outputs directory whose content will be uploaded.
    upload_bucket_name : str
        Name of the destination GCS bucket.
    computer_id : str
        Identifier of the computer or device producing the data.
    batchId : str
        Batch identifier used to group uploads.
    earliest_timestamp : datetime.datetime
        Earliest timestamp found in the dataset, used for folder naming.
    credential_path : str, optional
        Path to a valid Google Cloud service account JSON credentials file.

    Returns
    -------
    list of str
        A list of uploaded GCS object paths.

    Raises
    ------
    FileNotFoundError
        If the credentials file does not exist.
    google.api_core.exceptions.GoogleAPIError
        If the GCS upload fails.
    """
    if not credential_path or not os.path.exists(credential_path):
        raise FileNotFoundError(f"GCS credentials file not found: {credential_path}")

    creds = Credentials.from_service_account_file(credential_path)
    client = storage.Client(credentials=creds)
    bucket = client.bucket(upload_bucket_name)

    date_str = earliest_timestamp.strftime("%Y%m%d")
    datetime_str = earliest_timestamp.strftime("%Y%m%d-%H:%M")
    base_path = f"{computer_id}/{date_str}/{datetime_str}-{batchId}"

    if top_folder_name is None:
        top_folder_name = os.path.basename(os.path.normpath(outputs_dir))

    uploaded_files = []
    for root, _, files in os.walk(outputs_dir):
        for file in files:
            local_path = os.path.join(root, file)
            relative_path = os.path.relpath(local_path, start=outputs_dir).replace(os.sep, "/")
            gcs_path = f"{base_path}/{top_folder_name}/{relative_path}"

            blob = bucket.blob(gcs_path)
            blob.upload_from_filename(local_path)
            uploaded_files.append(gcs_path)

    return uploaded_files


def upload_to_gcs(gcs_upload_config=None, dataset_options=None, **kwargs):
    """
    Wrapper that loads configuration, determines upload metadata, and
    triggers the upload of output files to Google Cloud Storage.

    This function:
      1. Extracts the earliest timestamp from the raw data directory.
      2. Determines computer ID and batch ID either from:
         - a metadata.json file under dataset_options["gcs"], OR
         - kwargs (fallback), OR
         - default values.
      3. Calls `upload_outputs_to_gcs` to upload the output folder.

    Parameters
    ----------
    gcs_upload_config : dict, optional
        Optional GCS-related configuration (may be unused depending on pipeline).
    dataset_options : dict
        Configuration dictionary containing paths, timestamp_column_name,
        and optional `"gcs"` metadata settings.
    **kwargs :
        Additional optional arguments:
            credential_path : str
                Path to GCS credentials JSON file.
            bucket_name : str
                Name of the GCS bucket.
            computer : str, optional
                Fallback computer ID.
            batchId : str, optional
                Fallback batch ID.

    Returns
    -------
    None
        The function prints status messages and performs uploads via side-effects.

    Raises
    ------
    ValueError
        If timestamps cannot be extracted.
    FileNotFoundError
        If credentials are missing.
    google.api_core.exceptions.GoogleAPIError
        If upload fails.
    """

    credential_path = kwargs.get("credential_path")
    upload_bucket = kwargs.get("bucket_name")
    default_computer = "external"
    default_batchId = "None"
    metadata_path = None
    raw_data_dir = dataset_options["paths"]["raw_data"]
    timestamp_columns = DEFAULT_TIMESTAMP_COLUMNS()

    gcs_info = dataset_options.get("gcs")
    if not gcs_info:
        computer = kwargs.get("computer", default_computer)
        batchId = kwargs.get("batchId", default_batchId)
    else:
        metadata_file = gcs_info.get("metadata_file")
        if metadata_file is not None:
            metadata_path = os.path.expanduser(metadata_file)
        else:
            metadata_path = None
        if metadata_path is None or not os.path.exists(metadata_path):
            logger.warning("no metadata_file provided, defaulting to 'external'")
            computer = kwargs.get("computer", default_computer)
            batchId = kwargs.get("batchId", default_batchId)
        else:
            with open(metadata_path, "r") as f:
                metadata = json.load(f)
                data_section = metadata.get("data", {})
                computer = data_section.get("computer", default_computer)
                batchId = data_section.get("batchId", default_batchId)
    earliest_ts = extract_earliest_timestamp(raw_data_dir, timestamp_columns)
    outputs_dir = dataset_options["paths"]["outputs"]
    credential_path = os.path.expanduser(credential_path)
    logger.info("⬆️ Uploading results to GCS...")
    try:
        uploaded_outputs = upload_outputs_to_gcs(
            outputs_dir=outputs_dir,
            upload_bucket_name=upload_bucket,
            computer_id=computer,
            batchId=batchId,
            earliest_timestamp=earliest_ts,
            credential_path=credential_path,
            top_folder_name="outputs",
        )
        uploaded_rawdata = upload_outputs_to_gcs(
            outputs_dir=raw_data_dir,
            upload_bucket_name=upload_bucket,
            computer_id=computer,
            batchId=batchId,
            earliest_timestamp=earliest_ts,
            credential_path=credential_path,
            top_folder_name="data",
        )

        uploaded_files = uploaded_outputs + uploaded_rawdata
        logger.info(
            f"✅ Upload complete. \n # files uploaded {len(uploaded_files)}\n computer id: {computer}, batch_id: {batchId}")
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_filename = f"uploaded_files_{computer}_{batchId}_{timestamp}.json"
            uploaded_files_log = os.path.join(outputs_dir, log_filename)

            with open(uploaded_files_log, "w", encoding="utf-8") as f:
                json.dump(uploaded_files, f, ensure_ascii=False, indent=4)
        except Exception as e:
            logger.error(
                f"failed to save uploaded files list in ./uploaded_files_{computer}_{batchId}_{datetime.now()}.json {e}"
            )
        finally:
            try:
                if metadata_path is not None:
                    # empty content
                    with open(metadata_path, "w") as f:
                        f.write("{}")
            except Exception as e:
                logger.error(f"Could not clear metadata in path '{metadata_path}' {e}")
    except Exception as e:
        logger.error(f"❌ Upload failed: {e}")
