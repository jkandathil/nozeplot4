import datetime
import glob
import json
import os
import pathlib
import re
import shutil
import time
from collections import defaultdict
from typing import List, Sequence, Tuple, Union

import pandas as pd
import pytz
from google.cloud import storage

from nzalaac.constants.constant_values import CHR_ELEMENTS
from nzalaac.utils.data_preperation.general_utils import get_device_id
from nzalaac.utils.logger import ALAACLogger

logger = ALAACLogger(__name__)


def filter_timestamps(
        files_list: List[str],
        timestamp_range: Sequence[str],
        **options,
) -> List[str]:
    """
    Filter files by timestamp.

    Parameters
    ----------
    files_list
    timestamp_range
    options

    Returns
    -------
    """
    filtered_timestamp_list = []

    if timestamp_range[0] is not None or timestamp_range[1] is not None:
        start_time = (
            "20000101-0000" if timestamp_range[0] is None else timestamp_range[0]
        )
        end_time = "21000101-0000" if timestamp_range[1] is None else timestamp_range[1]

        # Timezones for filter
        est_timezone = pytz.timezone("US/Eastern")
        gmt_timezone = pytz.timezone("GMT")
        begin_time_dt = est_timezone.localize(
            datetime.datetime.strptime(start_time, "%Y%m%d-%H%M")
        ).astimezone(gmt_timezone) - datetime.timedelta(hours=1)
        end_time_dt = est_timezone.localize(
            datetime.datetime.strptime(end_time, "%Y%m%d-%H%M")
        ).astimezone(gmt_timezone) - datetime.timedelta(hours=1)

        # filter timeranges
        for filename in files_list:
            try:
                p = pathlib.Path(filename)
                basename, file_suffix = p.parts[-1].split(".")  # obtain file type
                # skips the file if it's not of the right file type
                parts = basename.split("_")
                timestamp = None
                for part in parts:
                    try:
                        timestamp = datetime.datetime.strptime(part, "%Y%m%d-%H%M")
                        timestamp = est_timezone.localize(timestamp).astimezone(
                            gmt_timezone
                        )
                        break
                    except ValueError:
                        continue
                if timestamp is None:
                    raise ValueError(f"No timestamp in file {basename}")

                # Applying date, device filters in their respective order
                if end_time_dt >= timestamp >= begin_time_dt:
                    filtered_timestamp_list.append(filename)

            except ValueError:
                pass
    else:
        filtered_timestamp_list = files_list

    return filtered_timestamp_list


async def prepare_raw_data(dataset_options):
    data_preparation = prepare_folders(dataset_options)

    raw_files_list = glob.glob(
        os.path.join(
            data_preparation["paths"]["raw_data"],
            "**/*.csv",
        ),
        recursive=True,
    )
    if data_preparation.get("timestamps") is not None:
        raw_files_list = filter_timestamps(
            raw_files_list,
            timestamp_range=[
                data_preparation["timestamps"].get("start", "20000101-0000"),
                data_preparation["timestamps"].get("end", "20500101-0000"),
            ],
        )

    return data_preparation, raw_files_list


def prepare_folders(data_preparation: dict):
    """
    Prepare folders and download data if needed from gcs.

    Parameters
    ----------
    data_preparation:
        config dictionary

    Returns
    -------
    data_preparation: dict
    """
    local_folders = data_preparation.get("paths", {})
    outputs = os.path.join(local_folders.get("outputs", "./"), "outputs/")
    dirs_to_create = {
        "raw_data": local_folders.get("raw_data", "./raw_data/"),
        "outputs": outputs,
        "output_files": os.path.join(
            local_folders.get("output_files", f"./{outputs}/files/"),
        ),
        "output_plots": os.path.join(
            local_folders.get("output_plots", f"./{outputs}/plots/")
        ),
    }

    # create folders if not exist or deleted
    if local_folders.get("clear_paths", True):
        for directory_str_path in ["outputs", "output_plots", "output_files"]:
            shutil.rmtree(dirs_to_create[directory_str_path], ignore_errors=True)

    for directory_str_path in dirs_to_create.values():
        pathlib.Path(directory_str_path).mkdir(parents=True, exist_ok=True)

    data_preparation["paths"].update(dirs_to_create)

    gcs_info = data_preparation.get("gcs", None)
    if gcs_info:
        if gcs_info.get("gcs_download", False):
            credentials_path = gcs_info.get("credentials_path")
            if credentials_path is None:
                raise ValueError("credentials_path not found in config")
            credentials_path = os.path.expanduser(credentials_path)
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
            if "metadata_file" in gcs_info:
                path = os.path.expanduser(gcs_info["metadata_file"])
                with open(path, "r") as f:
                    metadata = json.load(f)
                    protocols_and_annotation_ids = metadata.get("protocols", {})
                    data_preparation["metadata"] = metadata.get("data", {})
            else:
                protocols_and_annotation_ids = gcs_info.get("protocols", {})

            max_retries = gcs_info.get("max_retries", 3)
            retry_interval_seconds = gcs_info.get("retry_interval_seconds", 30)

            download_with_retries(
                bucket_name=gcs_info["bucket_name"],
                parent_folders=gcs_info.get("parent_folders", []),
                protocols_and_annotation_ids=protocols_and_annotation_ids,
                local_download_dir=gcs_info.get(
                    "local_download_dir", dirs_to_create["raw_data"]
                ),
                data_type=gcs_info.get("data_type", "raw"),
                max_retries=max_retries,
                retry_interval_seconds=retry_interval_seconds,
                logs_dir=dirs_to_create["outputs"] + "/logs",
            )

    return data_preparation


def load_input_json(json_path: str) -> dict:
    """
    Loads the content of a json file into a dictionary object.

    Parameters
    ----------
    json_path : the address to the json file

    Returns
    -------
    file_content : dict
        the content of the json file as a dictionary (dic) object
    """
    # Open the JSON file
    with open(json_path) as json_file:
        # Load the contents of the file
        config_dict = json.load(json_file)
    return config_dict
    # except FileNotFoundError as e:
    #     logger.exception("File not found.", str(e))
    # except json.JSONDecodeError as e:
    #     logger.exception("Error decoding JSON:", str(e))
    # except Exception as e:
    #     logger.exception("An error occurred:", str(e))
    #


def get_sensing_element_names(sensing_element_config):
    """
    Parameters
    ----------
    sensing_element_config

    Returns
    -------

    """
    if sensing_element_config is None:
        return CHR_ELEMENTS()
    elif type(sensing_element_config) is not dict and isinstance(
            sensing_element_config, Union[List, Tuple]
    ):
        return sensing_element_config

    to_expand = sensing_element_config.get("expand", {})
    expanded_list = []
    for key_name, start_end in to_expand.items():
        if len(start_end) == 0:
            continue
        if len(start_end) != 2:
            raise ValueError(
                f"Expected two items for key {key_name} when expanding, got {len(start_end)}"
            )
        expanded_list += [
            f"{key_name}{i}" for i in range(start_end[0], start_end[1] + 1)
        ]
    to_include = sensing_element_config.get("include", [])
    to_exclude = sensing_element_config.get("exclude", [])
    expand_list = expanded_list + [
        i for i in to_include if i not in expanded_list and i not in to_exclude
    ]
    sorted_list = sorted(
        expand_list,
        key=lambda s: (
            int(re.search(r"\d+$", s).group())
            if re.search(r"\d+$", s) is not None
            else -1
        ),
    )
    return sorted_list


def batch_by_device_id(list_df, **kwargs):
    """

    Parameters
    ----------
    list_df
    kwargs

    Returns
    -------

    """
    device_name_split_dfs = defaultdict(list)
    for df in list_df:
        device_name = get_device_id(df, **kwargs)
        if device_name is not None:
            device_name_split_dfs[device_name].append(df)

    return dict(device_name_split_dfs)


def csv_first_annotation_matches(blob, expected_id):
    """Check if the first row's annotation_id matches expected_id."""
    try:
        with blob.open("r") as f:
            df = pd.read_csv(f, nrows=1)
        if "annotation_id" not in df.columns:
            logger.warning(f"⚠️  'annotation_id' column missing in {blob.name}")
            return False

        first_value = str(df.loc[0, "annotation_id"])
        return first_value == str(expected_id)
    except Exception as e:
        logger.error(f"⚠️  Error reading {blob.name}: {e}")
        return False


def download_matching_csvs(
        bucket_name,
        parent_folders,
        protocols_and_annotation_ids,
        local_download_dir,
        data_type="raw",
):
    """
    Download CSV files from Google Cloud Storage (GCS) that match expected annotation IDs.

    This function scans protocol folders in a GCS bucket and downloads all CSV files whose
    filenames contain the expected annotation IDs for each protocol. It supports two modes:

    - **RAW mode**: directly downloads CSVs inside each protocol folder.
    - **PROCESSED mode**: finds the latest processed-data version folder and downloads CSVs from its `processed_data/` directory.
    Before downloading, the function clears the target directory (removes all subdirectories
    and files).

    Parameters
    ----------
    bucket_name : str
        Name of the GCS bucket.
    parent_folders : list of str
        Folder path segments that form the root prefix where protocols are stored.
    protocols_and_annotation_ids : dict
        Mapping of protocol names → list of annotation IDs to search for.
    local_download_dir : str
        Local directory where files will be downloaded. Contents are cleared at start.
    data_type : {"raw", "processed"}, default="raw"
        Controls whether RAW or PROCESSED logic is used.

    Returns
    -------
    set
        Set of annotation IDs that were successfully matched and downloaded.
    """

    found_ids = set()
    client = storage.Client()

    # Clean local directory
    os.makedirs(local_download_dir, exist_ok=True)
    for item in os.listdir(local_download_dir):
        item_path = os.path.join(local_download_dir, item)
        if os.path.isdir(item_path):
            shutil.rmtree(item_path)
        else:
            os.remove(item_path)

    base_prefix = "/".join(folder.strip("/") for folder in parent_folders)
    for protocol_name, annotation_ids in protocols_and_annotation_ids.items():
        protocol_prefix = f"{base_prefix}/{protocol_name}".rstrip("/") + "/"

        if data_type == "raw":
            blobs = client.list_blobs(bucket_name, prefix=protocol_prefix)

            for blob in blobs:
                if not blob.name.endswith(".csv") or "-val-nz_" in blob.name:
                    continue
                if blob.name.count("/") != protocol_prefix.count("/"):
                    continue

                filename = os.path.basename(blob.name)
                match_id = next(
                    (id for id in annotation_ids if id.split("-")[0] in filename), None
                )
                if match_id:
                    found_ids.add(match_id)
                    local_path = os.path.join(local_download_dir, filename)
                    blob.download_to_filename(local_path)
            continue

        # PROCESSED MODE
        blobs = list(client.list_blobs(bucket_name, prefix=protocol_prefix))
        parent_depth = protocol_prefix.count("/")
        version_folders = set()

        for blob in blobs:
            parts = blob.name.split("/")
            if len(parts) < parent_depth + 2:
                continue

            version = parts[parent_depth]
            if (
                    version
                    and "." in version
                    and not version.endswith(".csv")
                    and not version.endswith(".json")
            ):
                version_folders.add(version)

        if not version_folders:
            logger.error(f"⚠️ No processed data found inside {protocol_prefix}")
            continue

        latest_version = sorted(version_folders)[-1]
        processed_prefix = f"{protocol_prefix}{latest_version}/processed_data/"

        blobs = client.list_blobs(bucket_name, prefix=processed_prefix)

        for blob in blobs:
            if not blob.name.endswith(".csv") or "-val-nz_" in blob.name:
                continue

            filename = os.path.basename(blob.name)
            match_id = next(
                (id for id in annotation_ids if id.split("-")[0] in filename), None
            )

            if match_id:
                found_ids.add(match_id)
                rel_path = os.path.relpath(blob.name, start=base_prefix)
                local_path = os.path.join(local_download_dir, rel_path)
                os.makedirs(os.path.dirname(local_path), exist_ok=True)
                blob.download_to_filename(local_path)

    return found_ids


def download_with_retries(
        bucket_name,
        parent_folders,
        protocols_and_annotation_ids,
        local_download_dir,
        data_type,
        max_retries=5,
        retry_interval_seconds=60,
        logs_dir="./outputs/logs",
):
    """
    Retry wrapper for downloading annotation CSVs from GCS.

    This function repeatedly calls `download_matching_csvs` and verifies whether all expected annotation IDs were successfully downloaded.
    If some IDs are missing, the download attempt is retried after a specified delay.

    After all retries are exhausted, a log file is created summarizing which annotation IDs were still missing for each protocol.

    Parameters
    ----------
    bucket_name : str
        Name of the GCS bucket.
    parent_folders : list of str
        Folder path segments that form the root prefix where protocols are stored.
    protocols_and_annotation_ids : dict
        Mapping of protocol names → list of annotation IDs.
    local_download_dir : str
        Folder where files will be downloaded.
    data_type : {"raw", "processed"}
        Download mode to pass to `download_matching_csvs`.
    max_retries : int, default=5
        Maximum number of attempts before failing.
    retry_interval_seconds : int, default=60
        Seconds to wait between retry attempts.
    logs_dir : str, default="./outputs/logs"
        Directory where the missing-IDs log file will be saved.

    Returns
    -------
    None
        Returns early if all IDs are found, otherwise writes a log file before exiting.
    """

    for attempt in range(1, max_retries + 1):

        logger.info(f"\n🔄 Attempt {attempt}/{max_retries}...")

        found_ids = download_matching_csvs(
            bucket_name=bucket_name,
            parent_folders=parent_folders,
            protocols_and_annotation_ids=protocols_and_annotation_ids,
            local_download_dir=local_download_dir,
            data_type=data_type,
        )
        missing_by_protocol = {
            protocol: [ann for ann in ids if ann not in found_ids]
            for protocol, ids in protocols_and_annotation_ids.items()
        }

        missing = [ann for miss in missing_by_protocol.values() for ann in miss]

        if not missing:
            logger.info("✅ All annotation IDs successfully downloaded.")
            return

        logger.warning(f"⚠️ Missing annotation IDs: {missing}")

        if attempt < max_retries:
            logger.info(f"⏳ Retrying in {retry_interval_seconds} seconds...\n")
            time.sleep(retry_interval_seconds)

    logger.error("❌ Max retries reached. Some annotation IDs remain missing.")
    write_missing_log(
        log_dir=logs_dir,
        missing_by_protocol=missing_by_protocol,
        data_type=data_type,
        max_retries=max_retries,
    )

    return


def write_missing_log(log_dir, missing_by_protocol, data_type, max_retries):
    """
    Write a log file listing annotation IDs that were not found after all retries.

    The log file is overwritten on each call. It includes the timestamp, data type,
    number of retries performed, and the list of missing annotation IDs grouped by protocol.

    Parameters
    ----------
    log_dir : str
        Directory where the log file will be created.
    missing_by_protocol : dict
        Mapping of protocol names → list of annotation IDs that were not downloaded.
    data_type : str
        Whether RAW or PROCESSED data was requested.
    max_retries : int
        Number of retry attempts that were executed.

    Returns
    -------
    None
    """

    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "missing_annotations.log")

    # overwrite file
    with open(log_path, "w") as f:
        f.write("=========== Missing Annotation ===========\n")
        f.write(f"Timestamp: {datetime.datetime.now()}\n")
        f.write(f"Data type: {data_type}\n")
        f.write(f"Retries attempted: {max_retries}\n")
        f.write("-----------------------------------------\n\n")

        for protocol, missing_ids in missing_by_protocol.items():
            if missing_ids:
                f.write(f"Protocol: {protocol}\n")
                f.write("Missing Annotation IDs:\n")
                for ann in missing_ids:
                    f.write(f"   - {ann}\n")
                f.write("\n")
