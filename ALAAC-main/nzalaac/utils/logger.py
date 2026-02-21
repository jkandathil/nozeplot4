import logging
import uuid
from datetime import datetime
from pathlib import Path

# Level for real-time logs.
LOGGER_LEVEL = 10


run_uuid = None
run_timestamp = None
file_handler = None

def initialize_logger():
    global run_uuid, run_timestamp, file_handler
    run_uuid = str(uuid.uuid4())[:5]
    run_timestamp = datetime.now().strftime("%Y%m%d_%H-%M-%S")
    Path("logs").mkdir(exist_ok=True)
    file_handler = logging.FileHandler(f"logs/{run_timestamp}_{run_uuid}.log", mode="a")


class InfoFilter(logging.Filter):
    """Subclass Filter to print only logs to console."""

    def filter(self, record):
        """Custom filter for specific level of log."""
        return record.levelno == LOGGER_LEVEL


class ConsoleHandler(logging.StreamHandler):
    def emit(self, record):
        """Overridden emit, flushes after."""
        super().emit(record)
        self.flush()

    def __init__(self):
        super().__init__()
        # Format for console.
        self.addFilter(InfoFilter())
        self.setLevel(LOGGER_LEVEL)
        self.setFormatter(logging.Formatter("%(message)s"))


class ALAACLogger(logging.Logger):
    """ALAAC Pipeline Logger."""

    def __init__(self, name):
        # Use run UUID & datetime if available
        super().__init__(name)
        self.propagate = True

        # level 1 by default, but each handler has different levels.
        self.setLevel(LOGGER_LEVEL)

        # Format for output console.
        formatter = logging.Formatter(
            f"%(levelname)s - %(message)s - {run_timestamp}_{run_uuid}"
        )

        # handler for real time messages.
        flushing_console_handler = ConsoleHandler()

        # handler for messages to keep.
        persistent_console_handler = logging.StreamHandler()
        persistent_console_handler.setLevel(LOGGER_LEVEL)
        persistent_console_handler.setFormatter(formatter)

        # formatter for file
        file_formatter = logging.Formatter(
            f"{run_timestamp}_{run_uuid} - %(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )

        # handler for saving logs.
        file_handler.setLevel(LOGGER_LEVEL)
        file_handler.setFormatter(file_formatter)

        self.addHandler(flushing_console_handler)
        self.addHandler(file_handler)
        self.addHandler(persistent_console_handler)

    def flushing_log(self, message, *args, **kws):
        """Log and flush output."""
        self._log(LOGGER_LEVEL, message, args, **kws)
