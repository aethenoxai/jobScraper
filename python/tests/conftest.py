import sys
from pathlib import Path

# The helper's modules live next to this folder (python/), not in an installed package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
