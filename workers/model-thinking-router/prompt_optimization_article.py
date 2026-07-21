from __future__ import annotations

from pathlib import Path


ARTICLE_TEXT = (Path(__file__).with_name("prompt_optimization_article.md")).read_text().strip()
