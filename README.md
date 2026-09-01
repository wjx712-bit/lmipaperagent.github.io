# LMI Paper Agent

LMI 연구 주제와 관련된 논문을 지정 저널에서 수집하고, 공동 검토용 GitHub Pages에 게시하는 운영 저장소입니다.

## Production flow

1. 매주 일요일 09:00 KST에 GitHub Actions가 최근 14일을 겹쳐 조회합니다.
2. Crossref 메타데이터를 LMI rubric으로 평가하고 DOI 기준으로 중복을 제거합니다.
3. 누적 카탈로그와 최근 5년 웹 데이터가 갱신됩니다.
4. 데이터 커밋이 별도 Pages workflow를 호출해 사이트를 배포합니다.
5. Europe PMC에서 초록을 보강하고, 실제 초록이 확보된 논문만 사이트에 게시합니다.

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

## Abstract publishing and translation

사이트는 생성형 AI 상세 분석 대신 출판사가 제공한 원문 초록을 게시합니다. 영문 초록 수집과 게시에는 OpenAI 비용이 들지 않으며, 확보한 초록의 한국어 번역에만 OpenAI API를 사용합니다.

- Crossref가 제공한 초록은 수집 시 운영 카탈로그에 보존합니다.
- Europe PMC에서 DOI 기준으로 초록을 추가 확보합니다.
- 두 출처 모두에서 초록을 확보하지 못한 논문은 공개 사이트에서 제외합니다.
- 영문 초록은 `gpt-5.4-mini`로 한국어 번역하고 체크포인트 파일에 보존합니다.
- DOI 원문 링크와 Europe PMC 초록 출처 링크를 함께 제공합니다.

로컬에서 초록을 다시 수집하고 사이트 데이터를 내보낼 수 있습니다.

```powershell
python -m paper_agent.run_paper_analysis discover
python -m paper_agent.export_site_json
```

공개 초록 검색은 [Europe PMC REST API](https://europepmc.org/RestfulWebService)를 사용합니다.

## Data files

- `data/catalog/papers_table.csv`: DOI 중복 제거된 운영 카탈로그
- `data/weekly_updates/`: 실행일별 신규 논문
- `data/weekly_collection_state.json`: 마지막 실행 상태와 수집 건수
- `public/data/papers.json`: 웹사이트가 읽는 최근 5년 데이터
- `data/paper_analysis/source_index.json`: DOI별 초록과 출처 정보
- `data/abstract_translations/ko.json`: DOI별 한국어 초록 번역

다른 계정이나 컴퓨터에서 이어서 작업할 때 사용할 전체 프롬프트는 [CONTINUE_PROMPT.md](CONTINUE_PROMPT.md)에 있습니다.

수집 캐시는 `.cache/paper-analysis/`에만 저장되며 Git에는 올라가지 않습니다. 게시에 필요한 초록은 source index에 보존되므로 다른 컴퓨터에서도 저장소를 clone해 그대로 이어갈 수 있습니다.

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
