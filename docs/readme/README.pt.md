<h1 align="center">
  <a href="https://pebble.nebutra.com"><img src="../../resources/build/icon.png" alt="Pebble" width="64" valign="middle" /></a> Pebble
</h1>

<p align="center">
  <a href="https://github.com/nebutra/pebble/stargazers"><img src="https://badgen.net/github/stars/nebutra/pebble?label=%E2%98%85" alt="Estrelas no GitHub" /></a>
  <a href="https://github.com/nebutra/pebble/releases"><img src="../assets/readme-downloads.svg" alt="Total de downloads em todas as versões" /></a>
  <img src="https://badgen.net/github/license/nebutra/pebble" alt="Licença" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Entre no Discord do Pebble" /></a>
  <a href="https://x.com/pebble_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Siga o Pebble no X" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Plataformas compatíveis: macOS, Windows e Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a></sub>
</p>

<p align="center">
  <strong>O orquestrador de IA para builders 100x.</strong><br/>
  Rode Codex, ClaudeCode, OpenCode ou Pi lado a lado — cada um em seu próprio worktree, acompanhado em um só lugar.
</p>

<h3 align="center"><a href="https://pebble.nebutra.com/download"><ins>Baixar o Pebble</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="App desktop do Pebble executando agentes em worktrees paralelos, com o app companion móvel do Pebble no canto" width="960" />
</p>

## Recursos

<table>
<tr>
<td width="50%" valign="middle">

### Companion móvel

Monitore e conduza seus agentes pelo celular — receba uma notificação quando um agente terminar e envie instruções de acompanhamento de qualquer lugar.

[App Store para iOS](https://apps.apple.com/us/app/pebble-ide/id6766130217) · [TestFlight](https://testflight.apple.com/join/YjeGMQBA) · [APK Android 0.0.22](https://github.com/nebutra/pebble/releases/download/mobile-android-v0.0.22/app-release.apk) · [Docs →](https://pebble.nebutra.com/docs/mobile)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Pebble desktop com o app companion móvel" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees paralelos

Envie um mesmo prompt para cinco agentes, cada um em seu próprio worktree git isolado — compare os resultados e faça merge do vencedor.

[Docs →](https://pebble.nebutra.com/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/model/worktrees"><picture><source srcset="../assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/parallel-worktrees.jpg" alt="Orquestração de worktrees paralelos" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminais divididos

Terminais próprios do Pebble com renderização WebGL, divisões infinitas e scrollback que sobrevive a reinicializações.

[Docs →](https://pebble.nebutra.com/docs/terminal)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/terminal"><picture><source srcset="../assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="../assets/feature-wall/terminal-splits.jpg" alt="Terminais divididos" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Modo Design

Clique em qualquer elemento de UI em uma janela real do Chromium para enviar HTML, CSS e uma captura recortada direto para o prompt do seu agente.

[Docs →](https://pebble.nebutra.com/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/browser/design-mode"><picture><source srcset="../assets/feature-wall/design-mode.gif" type="image/gif"><img src="../assets/feature-wall/design-mode.jpg" alt="Navegador integrado e Modo Design" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub e Linear nativos

Navegue por PRs, issues e quadros de projeto dentro do app — abra um worktree a partir de qualquer tarefa e revise sem trocar de contexto.

[Docs →](https://pebble.nebutra.com/docs/review/linear)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/review/linear"><picture><source srcset="../assets/feature-wall/github-linear.gif" type="image/gif"><img src="../assets/feature-wall/github-linear.jpg" alt="Fluxos de trabalho de tarefas do GitHub e Linear no Pebble" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktrees por SSH

Execute agentes em uma máquina remota potente com edição completa de arquivos, git e terminais — com reconexão automática e encaminhamento de portas incluídos.

[Docs →](https://pebble.nebutra.com/docs/ssh)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/ssh"><picture><source srcset="../assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/ssh-worktrees.jpg" alt="Worktrees remotos por SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Anotar diffs de IA

Deixe comentários em qualquer linha de diff e envie-os de volta ao agente — revise, edite e faça commit sem sair do Pebble.

[Docs →](https://pebble.nebutra.com/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/review/annotate-ai-diff"><picture><source srcset="../assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="../assets/feature-wall/annotate-diff.jpg" alt="Anotar diffs gerados por IA" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Arraste arquivos para agentes

O editor do VS Code com salvamento automático em todos os lugares — arraste arquivos ou imagens direto para o prompt de um agente.

[Docs →](https://pebble.nebutra.com/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/editing/file-explorer"><picture><source srcset="../assets/feature-wall/file-drag.gif" type="image/gif"><img src="../assets/feature-wall/file-drag.jpg" alt="Arraste arquivos e imagens para o prompt de um agente" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Pebble CLI

Agentes também controlam o Pebble — automatize qualquer fluxo de trabalho com `pebble worktree create`, `snapshot`, `click` e `fill`.

[Docs →](https://pebble.nebutra.com/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://pebble.nebutra.com/docs/cli/overview"><picture><source srcset="../assets/feature-wall/pebble-cli.gif" type="image/gif"><img src="../assets/feature-wall/pebble-cli.jpg" alt="Automatize o Pebble pela CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**Também incluído:**

- **[Abertura rápida](https://pebble.nebutra.com/docs/model/quick-open)** — Pesquise entre worktrees, arquivos, agentes, comandos e contexto do repositório sem sair do seu fluxo.
- **[Troca de contas e acompanhamento de uso](https://pebble.nebutra.com/docs/agents/usage-tracking)** — Veja o uso de Claude e Codex, os reinícios de limites e troque contas instantaneamente sem fazer login de novo.
- **[Prévias ricas do repositório](https://pebble.nebutra.com/docs/editing/markdown)** — Pré-visualize Markdown, imagens, PDFs e documentos do repositório no workspace.
- **[Computer Use](https://pebble.nebutra.com/docs/cli/computer-use)** — Deixe agentes operarem apps de desktop e UI visível quando um fluxo de trabalho precisa de interação real.
- **[Notificações e estado de não lido](https://pebble.nebutra.com/docs/notifications)** — Saiba quando um agente termina ou precisa de atenção, depois marque conversas como não lidas para voltar depois.
- **E muito, muito mais** — lançamos novidades todos os dias, então esta lista vive atrasada. O [changelog](https://github.com/nebutra/pebble/releases) é a lista real de recursos.

---

## Agentes compatíveis

Funciona com **qualquer agente CLI** — se roda em um terminal, roda no Pebble.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Logotipo do Claude Code" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Logotipo do Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Logotipo do Grok" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Logotipo do Cursor" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="Logotipo do GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="Logotipo do OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="Logotipo do MiMo Code" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Logotipo do Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="Logotipo do OpenClaude" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Logotipo do Antigravity" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Logotipo do Pi" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="Logotipo do oh-my-pi" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Logotipo do Hermes Agent" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Logotipo do Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Logotipo do Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Logotipo do Auggie" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Logotipo do Autohand Code" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Logotipo do Charm" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Logotipo do Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Logotipo do Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Logotipo do Command Code" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Logotipo do Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Logotipo do Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Logotipo do Kilocode" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Logotipo do Kimi" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Logotipo do Kiro" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Logotipo do Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Logotipo do Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Logotipo do Rovo Dev" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ qualquer agente CLI</kbd>
</p>

---

## Instalação

### Desktop — macOS, Windows, Linux

- **[Baixe em pebble.nebutra.com](https://pebble.nebutra.com/download)**
- Ou baixe um build diretamente: [macOS Universal](https://github.com/nebutra/pebble/releases/latest/download/pebble-macos-universal.dmg) · [Windows (.exe)](https://github.com/nebutra/pebble/releases/latest/download/pebble-windows-x86_64-setup.exe) · [Linux x64 AppImage](https://github.com/nebutra/pebble/releases/latest/download/pebble-linux-x86_64.AppImage) · [Linux arm64 AppImage](https://github.com/nebutra/pebble/releases/latest/download/pebble-linux-aarch64.AppImage) · [Todos os builds](https://github.com/nebutra/pebble/releases/latest)
- Rodando `pebble serve` em um servidor Linux headless? Veja o [guia de servidor Linux headless](../reference/headless-linux-server.md).

_Ou por um gerenciador de pacotes:_

```bash
# macOS (Homebrew)
brew install --cask nebutra/pebble/pebble

# Arch Linux (AUR) — ou nebutra-pebble-git para compilar a partir do código-fonte
yay -S nebutra-pebble-bin
```

### Companion móvel — iOS, Android

Conecte ao app desktop para monitorar e conduzir seus agentes pelo celular.

- **iOS:** [Baixar na App Store](https://apps.apple.com/us/app/pebble-ide/id6766130217) ou [entrar no TestFlight](https://testflight.apple.com/join/YjeGMQBA)
- **Android:** [Baixar APK 0.0.22](https://github.com/nebutra/pebble/releases/download/mobile-android-v0.0.22/app-release.apk)

---

## Comunidade e suporte

- **Discord:** Entre na comunidade no **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Siga **[@pebble_build](https://x.com/pebble_build)** para atualizações e anúncios.
- **WeChat:** Escaneie o QR code para entrar na comunidade.

  <img src="../assets/wechat-qr.png" alt="QR code do WeChat para a comunidade Pebble" width="160" />

- **Feedback e ideias:** Lançamos rápido. Sentiu falta de algo? [Peça um novo recurso](https://github.com/nebutra/pebble/issues).
- **Privacidade:** Veja a [documentação de privacidade e telemetria](https://pebble.nebutra.com/docs/telemetry) para saber quais dados anônimos de uso o Pebble coleta e como desativar.
- **Mostre apoio:** Dê uma [estrela](https://github.com/nebutra/pebble) neste repositório para acompanhar nossos lançamentos diários.

---

## Desenvolvimento

Quer contribuir ou rodar localmente? Veja nosso guia [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

<a href="https://github.com/nebutra/pebble/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nebutra/pebble" alt="Contribuidores do Pebble" />
</a>

## Licença

Pebble é livre e de código aberto sob a [Licença MIT](../../LICENSE).
