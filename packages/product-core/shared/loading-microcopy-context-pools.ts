import type {
  LoadingMicrocopyContext,
  LoadingMicrocopyLocale
} from './loading-microcopy-types'

export const LOADING_MICROCOPY_BY_CONTEXT: Record<
  LoadingMicrocopyLocale,
  Record<LoadingMicrocopyContext, readonly string[]>
> = {
  en: {
    agent: [
      'Summoning agents...',
      'Waking the tiny braintrust...',
      'Passing notes to agents...',
      'Starting the group chat...',
      'Giving agents coffee...',
      'Assembling the task force...',
      'Checking who is online...',
      'Routing to the right brain...'
    ],
    api: [
      'Counting token crumbs...',
      'Checking the API meter...',
      'Reading the quota tea leaves...',
      'Balancing the token budget...',
      'Asking the rate limit nicely...',
      'Counting tiny invoices...',
      'Looking under the usage couch...',
      'Budgeting API coffee...'
    ],
    editor: [
      'Sharpening the cursor...',
      'Dusting the buffer...',
      'Polishing pixels...',
      'Convincing the editor...',
      'Lining up the monospace...',
      'Making the caret behave...',
      'Rehydrating the canvas...',
      'Opening the good tab...'
    ],
    file: [
      'Opening the drawer...',
      'Reading file breadcrumbs...',
      'Sorting the shelf...',
      'Finding the right folder...',
      'Following the path home...',
      'Unfolding the file map...',
      'Checking under the dotfiles...',
      'Putting paths in order...'
    ],
    git: [
      'Whispering to branches...',
      'Diff spelunking...',
      'Untangling commits...',
      'Asking Git what happened...',
      'Reading the reflog runes...',
      'Brushing off the branch dust...',
      'Finding the merge plot twist...',
      'Convincing history to load...'
    ],
    project: [
      'Herding tickets...',
      'Kanbaning gently...',
      'Sorting the board...',
      'Finding the right column...',
      'Turning chaos into cards...',
      'Reading the backlog weather...',
      'Stacking tiny priorities...',
      'Checking the project vibes...'
    ],
    review: [
      'Reading the diff tea...',
      'Summoning reviewers...',
      'Untangling PR lore...',
      'Checking CI gossip...',
      'Making sense of the red lines...',
      'Opening the review small talk...',
      'Finding the spicy hunk...',
      'Asking the checks to confess...'
    ],
    settings: [
      'Tuning the knobs...',
      'Calibrating vibes...',
      'Finding the good switch...',
      'Checking the preference drawer...',
      'Negotiating with system settings...',
      'Aligning the sliders...',
      'Looking for that one toggle...',
      'Reading the runtime manual...'
    ],
    terminal: [
      'Bootstrapping the shell...',
      'Warming the prompt...',
      'Pebbling the prompt...',
      'Starting prompt yoga...',
      'Feeding the PTY...',
      'Rolling out the terminal carpet...',
      'Teaching the cursor patience...',
      'Lighting the command line...'
    ],
    generic: [
      'Pebbling...',
      'Pebbling with intent...',
      'Musking...',
      'Zucking...',
      'Jobsing...',
      'Bezosing...',
      'Thinking...',
      'Shipping...',
      'Cooking...',
      'Crafting...',
      'Scaling...',
      'Seeding...',
      'Founding...',
      'Iterating...',
      'Exploring...',
      'Bootstrapping...',
      'Vibing...',
      'Building...',
      'Vibe checking...',
      'Making it shippable...',
      'Turning vibes into bytes...',
      'Letting it cook...',
      'Doing the tiny hard part...',
      'Almost emotionally available...',
      'Consulting the pebble...',
      'Pushing pixels uphill...',
      'Preparing the good version...'
    ]
  },
  zh: {
    agent: [
      '召唤小队中...',
      '唤醒智能体...',
      '给 agent 递咖啡...',
      '拉 agent 小群...',
      '分配脑细胞中...',
      '叫醒值班同学...',
      '让智能体排队上桌...',
      '正在组局干活...'
    ],
    api: [
      '数 token 小票...',
      '看额度水位...',
      '给 API 记账中...',
      '查额度余额宝...',
      '和 rate limit 好好说话...',
      '盘 token 珠子...',
      '核对调用账单...',
      '给预算做心肺复苏...'
    ],
    editor: [
      '给光标磨刀...',
      '擦亮编辑器...',
      '整理代码抽屉...',
      '让光标别抖...',
      '给像素找座位...',
      '把 buffer 熨平...',
      '给编辑器开个窗...',
      '正在把字排舒服...'
    ],
    file: [
      '翻文件小抽屉...',
      '摸索文件脉络...',
      '捞文件线索中...',
      '沿着路径摸过去...',
      '翻一下项目书包...',
      '给文件排队点名...',
      '从 dotfile 里找钥匙...',
      '把目录理顺中...'
    ],
    git: [
      '梳理分支宇宙...',
      '翻提交小账本...',
      '给 diff 顺毛...',
      '问问 Git 刚才发生了啥...',
      '看 reflog 算命中...',
      '给分支做心理疏导...',
      '寻找 merge 反转...',
      '把提交故事捋顺...'
    ],
    project: [
      '整理看板小山...',
      '捞项目清单...',
      '给任务排队中...',
      '把锅分给正确的人...',
      '从 backlog 里淘金...',
      '给卡片找泳道...',
      '把需求从雾里捞出来...',
      '给项目算今日运势...'
    ],
    review: [
      '翻 diff 小作文...',
      '召唤 reviewer...',
      '查 PR 玄学中...',
      '听 CI 讲八卦...',
      '给红线降降火...',
      '正在读评审弹幕...',
      '寻找最辣的 hunk...',
      '让 checks 交代问题...'
    ],
    settings: [
      '调旋钮中...',
      '校准偏好中...',
      '找那个开关中...',
      '和系统设置商量中...',
      '给开关做体检...',
      '把滑杆拨到舒服的位置...',
      '正在翻设置抽屉...',
      '查运行时说明书...'
    ],
    terminal: [
      '敲醒终端...',
      '点亮提示符...',
      '给 prompt 热身...',
      '给 PTY 喂饭中...',
      '铺开命令行地毯...',
      '让光标先冷静一下...',
      '终端开火中...',
      '把 shell 叫起来...'
    ],
    generic: [
      '溪石打磨中...',
      '鹅卵石抛光中...',
      '马斯克发射中...',
      '扎克拉群中...',
      '乔布斯打磨中...',
      '贝索斯扩容中...',
      '开工做饭中...',
      '认真摸鱼中...',
      '边想边造中...',
      '让灵感落地中...',
      '把玄学变工程...',
      '别催，在端菜了...',
      '已经在跑了...',
      '小石头快到了...',
      '先让它 cook 一下...',
      '正在优雅地加载...',
      '把想法揣兜里...',
      '再抛光一毫米...',
      '在了在了，马上...',
      '给生活加点技术含量...'
    ]
  },
  es: {
    agent: ['Convocando agentes...', 'Despertando mini cerebros...', 'Café para agentes...'],
    api: ['Contando tokens...', 'Mirando el medidor...', 'Presupuestando API...'],
    editor: ['Afilando el cursor...', 'Puliendo píxeles...', 'Ordenando el buffer...'],
    file: ['Abriendo el cajón...', 'Leyendo migas...', 'Ordenando la estantería...'],
    git: ['Susurrando ramas...', 'Buceando diffs...', 'Desenredando commits...'],
    project: ['Pastoreando tickets...', 'Kanbaneando...', 'Ordenando el tablero...'],
    review: ['Leyendo el té del diff...', 'Invocando reviewers...', 'Desenredando PRs...'],
    settings: ['Afinando perillas...', 'Calibrando vibes...', 'Buscando el switch bueno...'],
    terminal: ['Arrancando la shell...', 'Calentando el prompt...', 'Pebbleando el prompt...'],
    generic: ['Pebbling...', 'Cocinando...', 'Shippeando...', 'Iterando...', 'Construyendo...']
  },
  ja: {
    agent: ['エージェント召喚中...', '小さな頭脳を起動中...', 'agent にコーヒー中...'],
    api: ['token 勘定中...', 'メーター確認中...', 'API 家計簿中...'],
    editor: ['カーソル研ぎ中...', 'ピクセル磨き中...', 'バッファ整頓中...'],
    file: ['引き出し探索中...', 'ファイルの糸口探し中...', '棚を整え中...'],
    git: ['branch と対話中...', 'diff 探検中...', 'commit ほどき中...'],
    project: ['チケット整列中...', 'かんばん整理中...', 'ボード片付け中...'],
    review: ['diff 茶葉占い中...', 'reviewer 召喚中...', 'PR 物語を解読中...'],
    settings: ['つまみ調整中...', 'vibe 校正中...', '良いスイッチ探し中...'],
    terminal: ['shell 起動中...', 'prompt 温め中...', 'prompt を磨き中...'],
    generic: ['Pebbling...', '石を磨き中...', '調理中...', '出荷準備中...', '試行錯誤中...']
  },
  ko: {
    agent: ['에이전트 소환 중...', '작은 두뇌 깨우는 중...', 'agent 커피 타는 중...'],
    api: ['토큰 영수증 세는 중...', '미터 확인 중...', 'API 가계부 쓰는 중...'],
    editor: ['커서 갈아두는 중...', '픽셀 닦는 중...', '버퍼 정리 중...'],
    file: ['파일 서랍 여는 중...', '단서 줍는 중...', '선반 정리 중...'],
    git: ['브랜치와 대화 중...', 'diff 탐험 중...', '커밋 매듭 푸는 중...'],
    project: ['티켓 줄 세우는 중...', '칸반 정리 중...', '보드 정돈 중...'],
    review: ['diff 차잎 읽는 중...', '리뷰어 소환 중...', 'PR 전설 해독 중...'],
    settings: ['손잡이 조정 중...', 'vibe 보정 중...', '좋은 스위치 찾는 중...'],
    terminal: ['shell 깨우는 중...', 'prompt 데우는 중...', 'prompt 다듬는 중...'],
    generic: [
      'Pebbling...',
      '조약돌 다듬는 중...',
      '요리 중...',
      '배송 준비 중...',
      '빌드 감 잡는 중...'
    ]
  }
}
