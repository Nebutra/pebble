export type LoadingMicrocopyLocale = 'en' | 'zh' | 'es' | 'ja' | 'ko'

type LoadingMicrocopyContext =
  | 'agent'
  | 'api'
  | 'editor'
  | 'file'
  | 'git'
  | 'project'
  | 'review'
  | 'settings'
  | 'terminal'
  | 'generic'

const LOADING_MICROCOPY_BY_CONTEXT: Record<
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
    generic: ['Pebbling...', '조약돌 다듬는 중...', '요리 중...', '배송 준비 중...', '빌드 감 잡는 중...']
  }
}

const LOADING_MICROCOPY_OVERRIDES: Record<
  LoadingMicrocopyLocale,
  Array<[RegExp, readonly string[]]>
> = {
  en: [
    [
      /code context|context window/i,
      [
        'Packing the context window...',
        'Folding code into context...',
        'Making room in the context suitcase...',
        'Compressing the plot into tokens...',
        'Packing the repo lore...',
        'Giving the model the receipts...'
      ]
    ],
    [
      /check details|check run|checks panel|\bchecks?\b|\bci\b/i,
      [
        'Asking CI to use words...',
        'Listening to CI gossip...',
        'Reading the red-line weather...',
        'Waiting for the green check to stop posing...',
        'Making the flaky check explain itself...',
        'Finding the tiny failed assertion...'
      ]
    ],
    [
      /\breviewers?\b/i,
      [
        'Summoning reviewers...',
        'Sending reviewer invites...',
        'Warming up the review circle...',
        'Finding someone with context...',
        'Checking who still reads diffs...',
        'Putting fresh eyes on deck...'
      ]
    ],
    [
      /\blabels?\b/i,
      [
        'Sticker-sorting...',
        'Finding the right little tags...',
        'Labeling the tiny chaos...',
        'Opening the label drawer...',
        'Matching colors to consequences...',
        'Giving the issue a name tag...'
      ]
    ],
    [
      /\bassignees?\b|\bmembers?\b/i,
      [
        'Taking attendance...',
        'Finding the right human...',
        'Checking who owns the baton...',
        'Seeing who is in the room...',
        'Passing the baton politely...',
        'Finding the least surprised owner...'
      ]
    ],
    [
      /\bstates?\b|jira fields?|issue types?/i,
      [
        'Finding the workflow lane...',
        'Reading the Jira fine print...',
        'Sorting statuses by mood...',
        'Asking the workflow what it wants...',
        'Finding the next legal state...',
        'Translating process into buttons...'
      ]
    ],
    [
      /\bprojects?\b|project view|\bviews?\b|browse all|kanban|\bboard\b/i,
      [
        'Setting up the board game...',
        'Sorting cards by real life...',
        'Finding the column with gravity...',
        'Turning backlog fog into rows...',
        'Checking the project weather...',
        'Bringing the board back from the cloud...'
      ]
    ],
    [
      /\bfiles?\b|jump targets?|quickopen|quick open/i,
      [
        'Following file breadcrumbs...',
        'Opening the code drawer...',
        'Finding the path with a pulse...',
        'Indexing the little doors...',
        'Turning folders into shortcuts...',
        'Checking under the dotfiles...'
      ]
    ],
    [
      /api budget|rate limit|github api|gitlab api|quota|usage/i,
      [
        'Checking the API wallet...',
        'Reading the quota tea leaves...',
        'Counting token crumbs...',
        'Asking the rate limit nicely...',
        'Taking a tiny meter reading...',
        'Budgeting the next request...'
      ]
    ],
    [
      /wsl|distro|distributions?/i,
      [
        'Warming up WSL...',
        'Opening the Windows-Linux trapdoor...',
        'Checking the distro pantry...',
        'Finding the shell behind the wall...',
        'Negotiating the path translation...',
        'Getting the subsystem shoes on...'
      ]
    ],
    [
      /notification/i,
      [
        'Testing the tiny bell...',
        'Finding the polite ding...',
        'Negotiating with notifications...',
        'Making sure the bell has manners...',
        'Tuning the do-not-annoy knob...',
        'Checking the little red dot budget...'
      ]
    ],
    [
      /warp themes?|ghostty.*preview|terminal settings|terminalpane/i,
      [
        'Trying terminal outfits...',
        'Polishing the prompt wardrobe...',
        'Checking which theme has main-character energy...',
        'Teaching the terminal soft lighting...',
        'Importing the good terminal taste...',
        'Letting monospace pick an outfit...'
      ]
    ],
    [
      /\blog\b|\bruns?\b|automation/i,
      [
        'Tailing the log drama...',
        'Reading the robot diary...',
        'Waiting for the run to stop monologuing...',
        'Finding the interesting line...',
        'Letting the job explain itself...',
        'Following the automation breadcrumbs...'
      ]
    ],
    [
      /graph|git history|source-control|sourcecontrol|commit files?/i,
      [
        'Asking Git for the family tree...',
        'Untangling commit spaghetti...',
        'Reading branch archaeology...',
        'Finding the merge plot twist...',
        'Dusting off the commit trail...',
        'Making history sit still...'
      ]
    ],
    [
      /diff|conflict/i,
      [
        'Reading the spicy hunk...',
        'Unfolding the diff origami...',
        'Separating ours from theirs...',
        'Looking for the angry red line...',
        'Letting conflicts cool down...',
        'Finding what actually changed...'
      ]
    ],
    [
      /preview|image viewer|imageviewer/i,
      [
        'Warming up the preview glass...',
        'Letting pixels settle...',
        'Making the thumbnail honest...',
        'Opening the visual receipt...',
        'Rendering the tiny truth...',
        'Checking the picture before judging...'
      ]
    ],
    [
      /editor|tabgroup|tab group/i,
      [
        'Opening the good tab...',
        'Sharpening the cursor...',
        'Convincing the editor...',
        'Lining up the monospace...',
        'Giving the buffer a stretch...',
        'Teaching the caret patience...'
      ]
    ],
    [
      /conversation|native-chat|chat|earlier|loadingearlier/i,
      [
        'Fetching earlier lore...',
        'Scrolling the memory lane...',
        'Pulling old context forward...',
        'Finding where the thread left off...',
        'Reading the group chat archaeology...',
        'Bringing yesterday back gently...'
      ]
    ],
    [
      /sessions?|scanning/i,
      [
        'Checking which sessions are alive...',
        'Taking attendance in the agent room...',
        'Looking for active brainwaves...',
        'Finding the tab that is still thinking...',
        'Scanning for useful noise...',
        'Seeing who is still in the meeting...'
      ]
    ],
    [
      /settings|preferences?|sparse presets?|runtime/i,
      [
        'Finding the good switch...',
        'Opening the preference drawer...',
        'Tuning the knobs...',
        'Reading the runtime fine print...',
        'Looking for that one toggle...',
        'Calibrating the vibes responsibly...'
      ]
    ]
  ],
  zh: [
    [
      /code context|context window/i,
      [
        '往上下文窗塞干货...',
        '把代码前情提要补齐...',
        '压缩上下文行李...',
        '给模型递小抄...',
        '把仓库八卦装进 token...',
        '把前因后果揣进兜里...'
      ]
    ],
    [
      /check details|check run|checks panel|\bchecks?\b|\bci\b/i,
      [
        '听 CI 小道消息...',
        '让红叉讲人话...',
        '看绿色对勾摆不摆...',
        '让 checks 交代问题...',
        '给失败断言做笔录...',
        '看红线天气预报...'
      ]
    ],
    [
      /\breviewers?\b/i,
      [
        '召唤 reviewer...',
        '给 reviewer 发请帖...',
        '评审小群拉人中...',
        '看看谁还愿意看 diff...',
        '找有上下文的人类...',
        '给代码找第二双眼睛...'
      ]
    ],
    [
      /\blabels?\b/i,
      [
        '给任务贴小标签...',
        '整理标签贴纸...',
        '给混沌贴便签...',
        '把小红点分门别类...',
        '给 issue 贴姓名牌...',
        '挑一张不背锅的标签...'
      ]
    ],
    [
      /\bassignees?\b|\bmembers?\b/i,
      [
        '点名负责人...',
        '看看谁接棒...',
        '找今天在线的人类...',
        '把球优雅地传出去...',
        '确认谁在群里冒泡...',
        '找最不意外的 owner...'
      ]
    ],
    [
      /\bstates?\b|jira fields?|issue types?/i,
      [
        '找工作流的下一站...',
        '读 Jira 小字条款...',
        '给状态排资历...',
        '问流程想怎么走...',
        '把表单必填项凑齐...',
        '把流程翻译成按钮...'
      ]
    ],
    [
      /\bprojects?\b|project view|\bviews?\b|browse all|kanban|\bboard\b/i,
      [
        '把看板从云里捞回来...',
        '给卡片找泳道...',
        '把 backlog 雾气吹散...',
        '看项目今日运势...',
        '把需求摆成能看的样子...',
        '给项目牌桌洗牌...'
      ]
    ],
    [
      /\bfiles?\b|jump targets?|quickopen|quick open/i,
      [
        '翻文件小抽屉...',
        '沿着路径摸过去...',
        '给文件排队点名...',
        '把目录入口点亮...',
        '从 dotfile 里找钥匙...',
        '把跳转点摆上桌...'
      ]
    ],
    [
      /api budget|rate limit|github api|gitlab api|quota|usage/i,
      [
        '查 API 水表...',
        '数 token 小票...',
        '和 rate limit 好好说话...',
        '给额度拍个片...',
        '看 GitHub 钱包余额...',
        '给下一次调用凑预算...'
      ]
    ],
    [
      /wsl|distro|distributions?/i,
      [
        '给 WSL 热机...',
        '敲开 Windows 里的 Linux 门...',
        '找发行版小抽屉...',
        '校准路径翻译器...',
        '把子系统鞋带系紧...',
        '确认 shell 在隔壁房间...'
      ]
    ],
    [
      /notification/i,
      [
        '试铃铛别太吵...',
        '找一个礼貌的叮...',
        '和系统通知约法三章...',
        '调小社死音量...',
        '检查小红点预算...',
        '让提醒别上来就开麦...'
      ]
    ],
    [
      /warp themes?|ghostty.*preview|terminal settings|terminalpane/i,
      [
        '给终端试穿新衣...',
        '把 prompt 打磨圆一点...',
        '让等宽字排面拉满...',
        '给主题挑小红书滤镜...',
        '导入终端审美中...',
        '让命令行有点生活感...'
      ]
    ],
    [
      /\blog\b|\bruns?\b|automation/i,
      [
        '跟日志对口供...',
        '读自动化小日记...',
        '等流水线别碎碎念...',
        '找最关键那一行...',
        '让 job 自己解释一下...',
        '沿着运行痕迹摸过去...'
      ]
    ],
    [
      /graph|git history|source-control|sourcecontrol|commit files?/i,
      [
        '问 Git 要家谱...',
        '把提交线团拆开...',
        '做分支考古中...',
        '寻找 merge 反转...',
        '把历史按时间坐好...',
        '给 commit 轨迹除尘...'
      ]
    ],
    [
      /diff|conflict/i,
      [
        '翻 diff 小作文...',
        '寻找最辣的 hunk...',
        '把 ours/theirs 分开坐...',
        '给冲突降降火...',
        '看看红绿线谁有理...',
        '把改动折纸摊平...'
      ]
    ],
    [
      /preview|image viewer|imageviewer/i,
      [
        '等像素坐稳...',
        '让预览镜片起雾再擦亮...',
        '打开视觉小票...',
        '确认缩略图没骗人...',
        '给图片留一点体面...',
        '把预览灯打开...'
      ]
    ],
    [
      /editor|tabgroup|tab group/i,
      [
        '打开好用的那个 tab...',
        '给光标磨刀...',
        '把 buffer 熨平...',
        '让等宽字排队站好...',
        '给编辑器开个窗...',
        '让光标先冷静一下...'
      ]
    ],
    [
      /conversation|native-chat|chat|earlier|loadingearlier/i,
      [
        '翻聊天旧账中...',
        '往上扒拉消息...',
        '捞更早的上下文...',
        '把前面那段接回来...',
        '考古刚才聊到哪...',
        '把昨天的线头续上...'
      ]
    ],
    [
      /sessions?|scanning/i,
      [
        '点名活跃会话...',
        '看看哪个 tab 还在想...',
        '扫描有用的动静...',
        '给 agent 房间点名...',
        '寻找还没下班的脑波...',
        '确认谁还在会议里...'
      ]
    ],
    [
      /settings|preferences?|sparse presets?|runtime/i,
      [
        '找那个开关中...',
        '翻设置抽屉...',
        '调旋钮中...',
        '读运行时小字条款...',
        '给偏好做体检...',
        '把滑杆拨到舒服的位置...'
      ]
    ]
  ],
  es: [],
  ja: [],
  ko: []
}

const CONTEXT_PATTERNS: Array<[LoadingMicrocopyContext, RegExp]> = [
  ['settings', /setting|preference|notification|wsl|runtime|theme|preset|account|distro/i],
  ['api', /api|budget|rate|token|quota/i],
  ['review', /review|reviewer|pullrequest|pull-request|\bpr\b|\bmr\b|check|comment|conflict|\bci\b|hunk/i],
  ['agent', /agent|session|vault|orchestration|claude|codex/i],
  ['editor', /editor|preview|image|\bviewer\b|markdown|diff-section|content/i],
  ['file', /file|folder|explorer|quickopen|jump|target|path/i],
  ['git', /\bgit\b|branch|commit|submodule|graph|history|source-control|reflog|merge/i],
  ['project', /project|task|jira|linear|issue|ticket|\bboard\b|state|label|member|assignee/i],
  ['terminal', /terminal|shell|prompt|pty|xterm/i]
]

export const LOADING_MICROCOPY = LOADING_MICROCOPY_BY_CONTEXT.en.generic

export type LoadingMicrocopy = string

function resolveLoadingMicrocopyContext(seed: string): LoadingMicrocopyContext {
  for (const [context, pattern] of CONTEXT_PATTERNS) {
    if (pattern.test(seed)) {
      return context
    }
  }
  return 'generic'
}

function normalizeLoadingMicrocopyLocale(locale: string | undefined): LoadingMicrocopyLocale {
  if (locale?.startsWith('zh')) {
    return 'zh'
  }
  if (locale?.startsWith('es')) {
    return 'es'
  }
  if (locale?.startsWith('ja')) {
    return 'ja'
  }
  if (locale?.startsWith('ko')) {
    return 'ko'
  }
  return 'en'
}

function hashSeed(seed: string): number {
  let hash = 2166136261
  for (const character of seed) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function getLoadingMicrocopy(seed: string, locale?: string): LoadingMicrocopy {
  const normalizedLocale = normalizeLoadingMicrocopyLocale(locale)
  for (const [pattern, pool] of LOADING_MICROCOPY_OVERRIDES[normalizedLocale]) {
    if (pattern.test(seed)) {
      return pool[hashSeed(seed) % pool.length]!
    }
  }
  const context = resolveLoadingMicrocopyContext(seed)
  const pool = LOADING_MICROCOPY_BY_CONTEXT[normalizedLocale][context]
  return pool[hashSeed(seed) % pool.length]!
}

export function isLoadingMicrocopy(value: string): boolean {
  const trimmed = value.trim()
  const matchesContextPool = Object.values(LOADING_MICROCOPY_BY_CONTEXT).some((localePools) =>
    Object.values(localePools).some((pool) => pool.includes(trimmed))
  )
  const matchesOverridePool = Object.values(LOADING_MICROCOPY_OVERRIDES).some((localeOverrides) =>
    localeOverrides.some(([, pool]) => pool.includes(trimmed))
  )
  return matchesContextPool || matchesOverridePool
}
