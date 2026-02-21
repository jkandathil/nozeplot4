import asyncio
import sys
from importlib.resources import files

from nzalaac.utils.logger import initialize_logger

initialize_logger()

from nzalaac.nzalaac import pipeline

if __name__ == "__main__":
    if len(sys.argv) < 2:
        json_path = files('nzalaac.resources').joinpath("default_config.json")
        print(f"running default config {json_path}")
    else:
        json_path = sys.argv[1]
        print(f"running config {json_path}")

    asyncio.run(pipeline(json_path))
