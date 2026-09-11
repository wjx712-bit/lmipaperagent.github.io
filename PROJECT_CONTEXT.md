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
- Raw review persistence: Supabase PostgreSQL with RLS; author and administrator only. Approved members can read anonymous completion metadata through a separate RPC.
- Abstracts: Crossref and Europe PMC discovery; papers without a public abstract are not published
- Translation: hourly resumable English-to-Korean translation through `.github/workflows/abstract-translations.yml`
- Current public inventory (2026-09-10 topic backfill): 2,797 bilingual papers, including 542 adipose tissue/adipocyte papers and 17 papers in the explicit `미분류` review group

## Next milestone

2026-09-11 사용자 확인 후 과거 경로 보완: 사용자가 직접 제공하고 실행 승인한 7개 계정의 경로 정보로 기존 NULL 평가 57건만 보완했습니다. 점수, 노트, 작성/수정 시각, 평가 키, 기존 비NULL 경로는 보존 검사를 통과했습니다. 실제 변경은 6개 계정에 있었고 평가가 없는 1개 계정의 배정도 비공개 감사 기록에 포함했습니다. `review_origin_backfill_log`는 관리자만 조회할 수 있으며, 사후 사용자 확인 정보와 실제 브라우저 관측 경로를 구분하는 근거입니다. 개인별 매핑/변경 키는 공개 Git에 넣지 않습니다. 새 평가의 사이드바 연동, 분류, 전체 고유 논문 진행률은 바꾸지 않았습니다. DB 마이그레이션 `202609110002_review_origin_backfill_audit.sql`, 수동 도구 `supabase/maintenance/backfill_review_origins.sql` 및 해당 디렉터리 README를 참고합니다. 이후 추가 보완도 사용자 확인 없이 추정하거나 자동 적용하지 않습니다.

2026-09-11 승인된 평가 협업 변경: 일반 승인 멤버에게 점수/노트/신원을 제외한 다른 멤버의 평가 여부와 최초 평가 경로를 공유합니다. `review_completion(text[])` RPC는 승인 여부를 DB에서 확인하고 요청한 논문의 경로 집합/미기록 여부만 단일 JSON 스냅샷으로 반환합니다. 기존 private RLS는 그대로입니다. 전체 진행률은 한 명 이상 평가한 현재 공개 목록의 고유 논문 수 기준이며, 작업 주제 경유 진행률은 해당 경로가 실제 기록된 논문만 셉니다. `review_topic`은 첫 평가 경로이고 이후 수정/재방문에도 DB 트리거가 유지합니다. 기존 NULL은 추정하지 않으며 `__general__`은 명시적 전체 목록 경로입니다. 사용자-논문당 평가 1개는 유지합니다. 경로는 점수의 의미나 학습 정답 주제가 아닙니다.

작업 주제는 왼쪽 연구 주제 필터에 연동되며 별도 선택칸은 없습니다. 한 주제는 해당 경로, 주제 미선택은 전체 목록 경로로 자동 지정됩니다. 여러 주제일 때만 검토 시작 시 경로를 선택하고, 같은 주제 선택을 유지하는 동안 그 경로를 재사용합니다. 주제 필터 변경/초기화 시 이전 선택을 해제합니다. 선택한 작업 주제는 기존 필터에 교집합으로 적용됩니다. 기본 연속 검토는 내 미평가이며 타인 평가로 자동 건너뛰지 않습니다. 선택형 `현재 작업 주제에서 미평가만`은 다른 주제/미기록 경유 평가는 제외 근거로 쓰지 않습니다. 경로 조회 실패를 미평가로 취급하지 않습니다. 공유 현황은 저장 후/창 포커스 복귀/전경 60초 간격/수동 새로고침으로 갱신합니다. 관리자 개인별 기록/비교/CSV/JSON에도 최초 평가 경로를 포함합니다. 담당자 배정표, 예약/잠금, 공통 평가 샘플 배정 및 자동 학습은 이번 변경 범위가 아닙니다. DB 마이그레이션은 `202609110001_review_coordination.sql`, 테스트는 `pnpm test:coordination` 및 기존 UI 테스트입니다.

2026-09-10 승인된 예외: 사용자에게 증가분을 먼저 제시한 후, 기존 미분류 779편에만 기존 키워드 규칙을 보강된 영문 초록/제목으로 재적용했습니다. 762편은 기존 6개 주제에 추가하고 나머지 17편은 `미분류` 주제로 묶었습니다. 기존 분류 논문 2,018편은 전체 필드 그대로 보존했고, 나머지도 public topics / catalog themes 이외 필드는 바꾸지 않았습니다. 원본 카탈로그에도 기록하여 재내보내기 시 유지합니다. 내역은 `data/topic_backfills/empty-topics-2026-09-10.json`, 도구는 `paper_agent.backfill_unclassified_topics`입니다. 이는 새 실험 분류기 채택이나 추가 재분류에 대한 승인이 아닙니다. 새 평가 대상이 늘면 주제별 진행률 분모도 증가합니다.

평가 의미에 대한 사용자 확인: 주제별 배정은 작업 분담일 뿐, 1~5점은 담당 주제에 한정하지 않은 **연구실 전체 관련성**입니다. 기존 점수를 주제별 적합성 점수로 재해석하지 마세요. 평가 완료 후 점수·코멘트·불일치를 추합하고 관리자/교수님과 판단 기준을 합의한 다음 선별기와 수집 기준을 설계합니다. 현재는 자동 학습, 자동 제외, 기존 원점수 재산정을 하지 않습니다.

2026-09-10 별도 실험: 멤버는 기존 주제로 이미 배정되어 있으므로 운영 분류는 고정합니다. 관리자 `새 분류 미리보기`는 `src/classificationPreview.js`의 독립 규칙 초안을 현재 공개 제목/영문 초록에 적용합니다. 개인 평가를 입력하지 않고 새 결과를 기존 topics/진행률/대기열에 연결하지 않습니다. 적용 버튼, DB 저장, 자동 학습은 없습니다. 사용자 확인 후에도 명시적인 별도 전환 요청 없이 운영 분류를 바꾸지 마세요. 상세 경계는 `CLASSIFICATION_PREVIEW.md`를 참고합니다.

2026-09-10: 주제별 멤버 평가를 진행 중입니다. 모바일/목록 밀도 개선, 비로그인 통계 안내, 관리자 집계 범위 전환, 미평가 연속 검토를 추가했습니다. 이어 관리자 전용 저널·주제 분포, 주제별 진행률·원점수 집계, 평가 불일치 후보, 분류 품질 보고서와 CSV/JSON 내보내기를 구현했습니다. 사용자는 담당자 배정표 대신 현재 논문 주제 기준 집계를 명시적으로 선택했습니다. 평가 당시 주제·기준 버전은 미기록이며 추정해 채우지 않습니다. 기존 개인 원점수, 리뷰 노트, 최고점 후보 집계와 전문가 추천은 보존합니다. 모델 학습과 분류 교정은 시행하지 않았습니다. 운영 기준은 `REVIEW_WORKFLOW_AND_BACKLOG.md`를 참고합니다.

- Admin data: `is_lmi_admin` RPC를 조회 전후 확인하며 profiles/reviews를 고유 키 기반 커서로 끝까지 페이지 조회. 일부 조회 실패나 권한 회수 시 집계·내보내기 차단. 기존 DB RLS 유지, 스키마 변경 없음. 단일 트랜잭션 스냅샷은 아니므로 최종 학습 데이터 확정 시점의 동시 변경은 별도 통제 필요.
- Private exports are browser-local downloads only. Never commit personal notes, reviewer identities, or admin report downloads to the public repository.
- Classification QA is read-only. Before the approved empty-topic backfill: 779 unclassified, 417 liver-evidence candidates, 36 adipose / 370 omics / 159 aging missing-tag candidates. These are historical lexical checks, not confirmed errors. Recompute current counts rather than quoting this baseline as live state. The explicit `미분류` group still counts as unclassified in the quality audit.
- Source alignment replay: `python -m paper_agent.audit_classification_alignment --summary-only` reported 1,262 topic differences before the approved backfill. Export uses enriched abstracts but retains catalog themes; do not silently overwrite the ongoing evaluation set.
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
