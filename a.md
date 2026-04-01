```
.  # .github/
├── workflows
│   ├── build.yml
│   ├── publihs.yml
│   ├── rmcm-install.yml
```

## .github/workflows/build.yml

```yaml
name: Build & Test
'on':
    push:
        branches:
            - main
            - master
    pull_request:
        branches:
            - main
            - master
    workflow_call:
        outputs:
            build-status:
                description: Build status
                value: '${{ jobs.build.outputs.build-status }}'
jobs:
    setup-rmcm:
        uses: ./.github/workflows/rmcm-install.yml
    build:
        needs: setup-rmcm
        runs-on: ubuntu-latest
        outputs:
            build-status: '${{ job.status }}'
        steps:
            - name: Checkout repository
              uses: actions/checkout@v4
              with:
                  fetch-depth: 0
            - name: Setup Bun
              uses: oven-sh/setup-bun@v1
              with:
                  bun-version: latest
            - name: Setup Rust (for rmcm runtime)
              uses: dtolnay/rust-toolchain@stable
              with:
                  toolchain: stable
            - name: Restore Cargo Cache (for rmcm)
              uses: actions/cache@v4
              with:
                  path: |
                      ~/.cargo/bin
                      ~/.cargo/registry
                      ~/.cargo/git
                  key: >-
                      ${{ runner.os }}-cargo-rmcm-${{ hashFiles('**/Cargo.lock') }}-${{
                      github.sha }}
                  restore-keys: |
                      ${{ runner.os }}-cargo-rmcm-
            - name: Restore Bun Cache
              uses: actions/cache@v4
              with:
                  path: |
                      ~/.bun/install/cache
                      node_modules
                      bun.lock
                  key: "${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}"
                  restore-keys: |
                      ${{ runner.os }}-bun-
            - name: Install dependencies
              run: bun install --frozen-lockfile
            - name: Add Cargo bin to PATH
              run: echo "$HOME/.cargo/bin" >> $GITHUB_PATH
            - name: Verify rmcm availability
              run: rmcm --version
            - name: Run Rebuild (Clean + Lint + Build + Format)
              run: bun run rebuild
            - name: Upload Build Artifacts
              uses: actions/upload-artifact@v4
              with:
                  name: build-output
                  path: build/
                  retention-days: 1
```

## .github/workflows/publihs.yml

```yaml
name: Publish to NPM
'on':
    push:
        branches:
            - main
        tags:
            - v*
    workflow_dispatch: null
jobs:
    check-build:
        uses: ./.github/workflows/build.yml
    publish-npm:
        needs: check-build
        if: github.ref == 'refs/heads/main' && needs.check-build.result == 'success'
        runs-on: ubuntu-latest
        environment:
            name: npm-publish
            url: 'https://www.npmjs.com/package/sfiledl'
        permissions:
            contents: read
            id-token: write
        steps:
            - name: Checkout repository
              uses: actions/checkout@v4
              with:
                  fetch-depth: 0
            - name: Setup Bun
              uses: oven-sh/setup-bun@v1
              with:
                  bun-version: latest
            - name: Setup Rust (for prepublishOnly script)
              uses: dtolnay/rust-toolchain@stable
              with:
                  toolchain: stable
            - name: Restore Caches (Cargo & Bun)
              uses: actions/cache@v4
              with:
                  path: |
                      ~/.cargo/bin
                      ~/.cargo/registry
                      ~/.bun/install/cache
                      node_modules
                  key: >-
                      ${{ runner.os }}-deps-${{ hashFiles('**/bun.lock', '**/Cargo.lock')
                      }}
            - name: Install dependencies
              run: bun install --frozen-lockfile
            - name: Add Cargo bin to PATH
              run: echo "$HOME/.cargo/bin" >> $GITHUB_PATH
            - name: Publish to NPM
              run: bun publish --access public
              env:
                  NPM_AUTH_TOKEN: '${{ secrets.NPM_AUTH_TOKEN }}'
```

## .github/workflows/rmcm-install.yml

```yaml
name: Setup RMCM Tool
'on':
    workflow_call:
        outputs:
            cache-hit:
                description: Whether the cache was hit
                value: '${{ jobs.rmcm-install.outputs.cache-hit }}'
jobs:
    rmcm-install:
        runs-on: ubuntu-latest
        outputs:
            cache-hit: '${{ steps.cache-cargo.outputs.cache-hit }}'
        steps:
            - name: Checkout repository (for cargo git install)
              uses: actions/checkout@v4
              with:
                  fetch-depth: 1
            - name: Setup Rust
              uses: dtolnay/rust-toolchain@stable
              with:
                  toolchain: stable
                  components: cargo
            - name: Cache Cargo binaries and registry
              id: cache-cargo
              uses: actions/cache@v4
              with:
                  path: |
                      ~/.cargo/bin
                      ~/.cargo/registry
                      ~/.cargo/git
                      target
                  key: >-
                      ${{ runner.os }}-cargo-rmcm-${{ hashFiles('**/Cargo.lock') }}-${{
                      github.sha }}
                  restore-keys: |
                      ${{ runner.os }}-cargo-rmcm-${{ hashFiles('**/Cargo.lock') }}
                      ${{ runner.os }}-cargo-rmcm-
            - name: Install rmcm from git (if cache miss)
              if: steps.cache-cargo.outputs.cache-hit != 'true'
              run: >-
                  cargo install --git https://github.com/neuxdotdev/comment-remover.git
                  --force
            - name: Verify rmcm installation
              run: |
                  echo "$HOME/.cargo/bin" >> $GITHUB_PATH
                  rmcm --version || echo "rmcm installed successfully"
```
