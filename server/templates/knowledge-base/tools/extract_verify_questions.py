"""
Extract questions-only file from a full verify dataset.
Removes expected_answer and source_file fields, adds knowledge_path and output_path.

Usage:
    python tools/extract_verify_questions.py <full-dataset-path>

Output:
    Saves to the same directory with "-questions" suffix.
    e.g. verify/verify-xxx-2026-06-21.json → verify/verify-xxx-2026-06-21-questions.json
"""

import json
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print("Usage: python tools/extract_verify_questions.py <full-dataset-path>")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    if not input_path.exists():
        print(f"Error: {input_path} not found")
        sys.exit(1)

    with open(input_path, "r", encoding="utf-8") as f:
        dataset = json.load(f)

    canonical_run_layout = input_path.name == "dataset.json"
    output_filename = "questions.json" if canonical_run_layout else input_path.stem + "-questions" + input_path.suffix
    output_path = input_path.parent / output_filename
    knowledge_answers_filename = "knowledge-answers.json" if canonical_run_layout else input_path.stem + "-knowledge-answers" + input_path.suffix
    knowledge_answers_path = str(input_path.parent / knowledge_answers_filename)

    questions_only = {
        **{key: dataset[key] for key in ("plan_id", "draft_id") if dataset.get(key)},
        "knowledge_path": dataset["knowledge_path"],
        "output_path": knowledge_answers_path,
        "questions": [
            {"id": q["id"], "level": q["level"], "question": q["question"]}
            for q in dataset["questions"]
        ],
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(questions_only, f, ensure_ascii=False, indent=2)

    print(f"Saved questions-only file to: {output_path}")


if __name__ == "__main__":
    main()
