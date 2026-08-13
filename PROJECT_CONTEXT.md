# Project Context

## Objective

LMI 연구 주제 관련 논문을 14개 지정 저널에서 자동 수집하고, 매주 일요일 GitHub Pages에 게시하며 연구실 구성원이 1-5점과 노트를 남기는 시스템입니다.

## Current architecture

- Frontend: Vite, React, GitHub Pages
- Collection: Python, Crossref REST API
- Ranking: `config/lab_profile.yml` 키워드 그룹과 `config/relevance_rubric.yml`
- Schedule: `.github/workflows/weekly-production-update.yml`, Sunday 09:00 KST
- Production data: rolling 365-day JSON, cumulative CSV catalog
- Authentication: Supabase Google OAuth, administrator-approved membership
- Review persistence: Supabase PostgreSQL with RLS; author and administrator only
- Detail analysis: Europe PMC full text/abstract discovery, PMC OA figure packages, OpenAI Batch structured output
- Analysis schedule: `.github/workflows/paper-analysis.yml`, resumable every six hours after `OPENAI_API_KEY` is configured
- Current source inventory: 2,688 papers checked; 1,305 full text, 951 abstract, 432 public source unavailable

## Next milestone

Supabase 프로젝트에 migration을 적용하고 Google provider 및 GitHub Repository variables를 등록해 인증을 활성화합니다. 이후 전문가 추천 관리와 리뷰 피드백의 다음 주 ranking 반영을 구현합니다. Service role key는 프런트엔드에 절대 포함하지 않습니다.

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
