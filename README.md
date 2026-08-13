# LMI Paper Agent

LMI 연구 주제와 관련된 논문을 지정 저널에서 수집하고, 공동 검토용 GitHub Pages에 게시하는 운영 저장소입니다.

## Production flow

1. 매주 일요일 09:00 KST에 GitHub Actions가 최근 14일을 겹쳐 조회합니다.
2. Crossref 메타데이터를 LMI rubric으로 평가하고 DOI 기준으로 중복을 제거합니다.
3. 누적 카탈로그와 최근 1년 웹 데이터가 갱신됩니다.
4. 데이터 커밋이 별도 Pages workflow를 호출해 사이트를 배포합니다.
5. Europe PMC에서 공개 전문·초록 가능 여부를 판정하고 상세 분석 대기열을 갱신합니다.

감시 저널과 연구 키워드는 각각 `config/journals.yml`, `config/lab_profile.yml`에서 수정합니다. 교수·박사 추천은 `config/expert_recommendations.csv`에 DOI, 이름, 역할, 메모를 추가하면 사이트에 표시됩니다.

## Local development

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
corepack enable
pnpm install
pnpm dev
```

## Verification

```powershell
python -m unittest discover -s tests -v
python -m paper_agent.export_site_json --as-of 2026-08-13
pnpm build
```

## Manual production update

GitHub의 `Actions > Weekly Production Update > Run workflow`에서 즉시 실행할 수 있습니다. Crossref polite pool 사용을 위해 저장소 Secret `LMI_CROSSREF_MAILTO`에 연락용 이메일을 등록하는 것을 권장합니다.

## Structured paper analysis

상세 분석은 원문 근거 수준을 숨기지 않습니다.

- `full_text`: Europe PMC 공개 본문, figure caption, PMC Open Access package의 figure 이미지를 사용합니다.
- `abstract`: 초록에 명시된 범위만 분석하며 figure별 분석은 생성하지 않습니다.
- `source_unavailable`: 현재 공개 전문이나 초록이 없어 분석을 보류합니다.

분석 결과에는 Research background, main question, hypothesis, experimental models, methods, key results, summary, conclusion, limitations, figure-by-figure analysis와 DOI 원문 링크가 포함됩니다. OpenAI Structured Outputs로 스키마를 고정하고, Batch API의 `custom_id`로 응답 순서와 관계없이 각 DOI에 결과를 연결합니다.

GitHub 저장소의 `Settings > Secrets and variables > Actions`에서 Secret `OPENAI_API_KEY`를 등록하면 `Paper Detail Analysis` workflow가 6시간마다 미완료 논문을 재개합니다. 키는 코드, CSV, 채팅에 넣지 않습니다. 모델을 바꿀 때는 Repository variable `OPENAI_ANALYSIS_MODEL`을 설정합니다.

로컬에서 단계별로 실행할 수도 있습니다.

```powershell
python -m paper_agent.run_paper_analysis discover
python -m paper_agent.run_paper_analysis build-batch --limit 10 --evidence-level full_text
$env:OPENAI_API_KEY = "your-key"
python -m paper_agent.run_paper_analysis submit-batch --input .cache/paper-analysis/batch_inputs/<batch>.jsonl
python -m paper_agent.run_paper_analysis sync-batches
python -m paper_agent.run_paper_analysis status
```

대규모 초기 적재는 `run-cycle`이 출처 재확인, 완료 Batch 회수, 새 Batch 제출을 한 번에 수행합니다.

```powershell
python -m paper_agent.run_paper_analysis run-cycle --batch-count 2 --papers-per-batch 20
```

공개 출처 검색은 [Europe PMC REST API](https://europepmc.org/RestfulWebService), figure package는 [PMC OA Web Service](https://pmc.ncbi.nlm.nih.gov/tools/oa-service/), 비동기 분석은 [OpenAI Batch API](https://developers.openai.com/api/docs/guides/batch)를 사용합니다.

## Data files

- `data/catalog/papers_table.csv`: DOI 중복 제거된 운영 카탈로그
- `data/weekly_updates/`: 실행일별 신규 논문
- `data/weekly_collection_state.json`: 마지막 실행 상태와 수집 건수
- `public/data/papers.json`: 웹사이트가 읽는 최근 1년 데이터
- `data/paper_analysis/source_index.json`: 2,688편의 출처·분석 진행 상태
- `data/paper_analysis/batches.json`: 제출한 Batch와 회수 상태
- `public/data/analysis-index.json`: 웹사이트용 상세 분석 상태 인덱스
- `public/data/analysis/`: 완료된 논문별 구조화 분석 JSON

원문 XML과 figure 파일, Batch 입력은 `.cache/paper-analysis/`에만 저장되고 Git에는 올라가지 않습니다. 따라서 다른 컴퓨터에서도 저장소를 clone한 뒤 source index를 이용해 필요한 공개 원문만 다시 받아 이어갈 수 있습니다.

Supabase가 설정되기 전에는 리뷰가 브라우저별 `localStorage`에 임시 저장됩니다. 설정 후 승인된 계정으로 처음 로그인하면 해당 브라우저의 기존 리뷰가 본인 계정으로 한 번 이전됩니다.

## Login and private reviews

사이트는 Supabase Google Auth를 사용합니다. 신규 사용자는 `pending`으로 등록되고, 관리자가 승인한 뒤 본인 평가를 작성할 수 있습니다. 일반 사용자는 본인의 점수와 노트만 읽을 수 있으며, `wjx712@gmail.com` 관리자만 모든 개인 평가와 가입 요청을 볼 수 있습니다. 이 제한은 화면 코드가 아니라 PostgreSQL Row Level Security에서 강제됩니다.

1. Supabase 프로젝트의 SQL Editor에서 `supabase/migrations/202608130001_auth_and_reviews.sql` 전체를 실행합니다.
2. Supabase `Authentication > Providers > Google`에서 Google 로그인을 활성화합니다.
3. Supabase `Authentication > URL Configuration`에 아래 주소를 등록합니다.

```text
Site URL: https://wjx712-bit.github.io/lmipaperagent.github.io/
Redirect URL: https://wjx712-bit.github.io/lmipaperagent.github.io/
Local redirect: http://localhost:5173/
```

4. GitHub `Settings > Secrets and variables > Actions > Variables`에 다음 두 Repository variable을 등록합니다.

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
```

5. `Deploy GitHub Pages` workflow를 실행합니다. 관리자가 Google 로그인하면 자동 승인되며, 이후 `평가 관리` 화면에서 구성원을 승인하거나 차단할 수 있습니다.

Supabase anon/publishable key는 브라우저에 포함되는 공개 키입니다. `service_role` key는 절대로 GitHub variable이나 프런트엔드에 등록하지 않습니다. 기존 브라우저 평가는 승인된 계정으로 첫 로그인할 때 한 번 자동 이전됩니다.
