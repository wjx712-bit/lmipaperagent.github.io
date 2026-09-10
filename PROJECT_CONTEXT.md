# Project Context

## Objective

LMI 연구 주제 관련 논문을 14개 지정 저널에서 자동 수집하고, 매주 일요일 GitHub Pages에 게시하며 연구실 구성원이 1-5점과 노트를 남기는 시스템입니다.

## Current architecture

- Frontend: Vite, React, GitHub Pages
- Collection: Python, Crossref REST API
- Ranking: `config/lab_profile.yml` 키워드 그룹과 `config/relevance_rubric.yml`
- Schedule: `.github/workflows/weekly-production-update.yml`; Sunday collection is currently paused during member evaluation (manual dispatch remains available)
- Production data: rolling 1,825-day public JSON, cumulative CSV catalog
- Authentication: Supabase Google OAuth, administrator-approved membership
- Review persistence: Supabase PostgreSQL with RLS; author and administrator only
- Abstracts: Crossref and Europe PMC discovery; papers without a public abstract are not published
- Translation: hourly resumable English-to-Korean translation through `.github/workflows/abstract-translations.yml`
- Current public inventory (2026-09-01): 2,797 bilingual papers, including 540 adipose tissue/adipocyte papers

## Next milestone

2026-09-10: 주제별 멤버 평가를 진행 중입니다. 모바일/목록 밀도 개선, 비로그인 통계 안내, 관리자 집계 범위 전환, 미평가 연속 검토를 추가했습니다. 이어 관리자 전용 저널·주제 분포, 주제별 진행률·원점수 집계, 평가 불일치 후보, 분류 품질 보고서와 CSV/JSON 내보내기를 구현했습니다. 사용자는 담당자 배정표 대신 현재 논문 주제 기준 집계를 명시적으로 선택했습니다. 평가 당시 주제·기준 버전은 미기록이며 추정해 채우지 않습니다. 기존 개인 원점수, 리뷰 노트, 최고점 후보 집계와 전문가 추천은 보존합니다. 모델 학습과 분류 교정은 시행하지 않았습니다. 운영 기준은 `REVIEW_WORKFLOW_AND_BACKLOG.md`를 참고합니다.

- Admin data: `is_lmi_admin` RPC를 조회 전후 확인하며 profiles/reviews를 고유 키 기반 커서로 끝까지 페이지 조회. 일부 조회 실패나 권한 회수 시 집계·내보내기 차단. 기존 DB RLS 유지, 스키마 변경 없음. 단일 트랜잭션 스냅샷은 아니므로 최종 학습 데이터 확정 시점의 동시 변경은 별도 통제 필요.
- Private exports are browser-local downloads only. Never commit personal notes, reviewer identities, or admin report downloads to the public repository.
- Classification QA is read-only: 779 unclassified, 417 liver-evidence check candidates, 36 adipose / 370 omics / 159 aging missing-tag candidates. These are lexical checks, not confirmed errors. A paper may match multiple flags.
- Source alignment replay: `python -m paper_agent.audit_classification_alignment --summary-only` reports 1,262 topic differences on the 2026-09-10 dataset. Export uses enriched abstracts but retains catalog themes; do not silently overwrite the ongoing evaluation set.
- Validation: `node --test tests/admin-analytics.test.mjs tests/admin-data.test.mjs tests/classification-audit.test.mjs`, Python unittest suite, and local-only Playwright `tests/ui-admin.mjs` / `tests/ui-review.mjs`.

운영 사이트, Google 로그인, 관리자 승인, 개인 평가 RLS, 한국어 초록 번역이 활성화되어 있습니다. 주간 자동 수집은 멤버 평가 기간 동안 일시정지되어 있습니다. 다음 변경은 실제 운영 데이터를 보존하면서 진행하고, Service role key는 프런트엔드에 절대 포함하지 않습니다.

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
