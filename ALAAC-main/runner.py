
import asyncio
from multiprocessing import freeze_support

from nzalaac.nzalaac import pipeline
from nzalaac.utils.logger import initialize_logger


def main():
    asyncio.run(pipeline("./demos/demo.json"))

if __name__ == "__main__":
    freeze_support()
    main()
