# Project Context

## Objective

LMI 연구 주제 관련 논문을 14개 지정 저널에서 자동 수집하고, 매주 일요일 GitHub Pages에 게시하며 연구실 구성원이 1-5점과 노트를 남기는 시스템입니다.

## Current architecture

- Frontend: Vite, React, GitHub Pages
- Collection: Python, Crossref REST API
- Ranking: `config/lab_profile.yml` 키워드 그룹과 `config/relevance_rubric.yml`
- Schedule: `.github/workflows/weekly-production-update.yml`, Sunday 09:00 KST
- Production data: rolling 1,825-day public JSON, cumulative CSV catalog
- Authentication: Supabase Google OAuth, administrator-approved membership
- Review persistence: Supabase PostgreSQL with RLS; author and administrator only
- Abstracts: Crossref and Europe PMC discovery; papers without a public abstract are not published
- Translation: hourly resumable English-to-Korean translation through `.github/workflows/abstract-translations.yml`
- Current public inventory (2026-09-01): 2,797 bilingual papers, including 540 adipose tissue/adipocyte papers

## Next milestone

운영 사이트, Google 로그인, 관리자 승인, 개인 평가 RLS, 주간 수집, 한국어 초록 번역이 활성화되어 있습니다. 다음 변경은 실제 운영 데이터를 보존하면서 진행하고, Service role key는 프런트엔드에 절대 포함하지 않습니다.

## Continue on another computer

```powershell
git clone https://github.com/wjx712-bit/lmipaperagent.github.io.git
cd lmipaperagent.github.io
corepack enable
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

새 Codex 작업에서 `README.md`, `PROJECT_CONTEXT.md`, 최근 `git log`, `git status`를 먼저 읽도록 요청하면 현재 맥락에서 바로 이어갈 수 있습니다.

복사해서 사용할 전체 인수인계 프롬프트는 [CONTINUE_PROMPT.md](CONTINUE_PROMPT.md)에 있습니다.
