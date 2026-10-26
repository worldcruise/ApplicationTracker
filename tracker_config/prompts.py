"""The legacy prompt-file resolution contract shared by capture and Studio."""
from pathlib import Path


def legacy_prompt_path(candidate, config_directory: Path, template_directory: Path) -> Path:
    if candidate.get("promptFilePath"):
        path = Path(candidate["promptFilePath"]).expanduser()
        if not path.is_absolute():
            raise ValueError("The candidate prompt file path must be absolute.")
        if path.suffix.lower() not in {".txt", ".md"} or not path.is_file():
            raise ValueError("The candidate prompt file is missing or is not .txt or .md.")
        return path
    path = (config_directory / Path(candidate["promptTemplate"])).resolve()
    if not path.is_relative_to(template_directory.resolve()):
        raise ValueError("Candidate template path is outside templates.")
    return path
