// Chinese seed-pattern → phrase overrides, split out of loading-microcopy-overrides.ts.
export const LOADING_MICROCOPY_OVERRIDES_ZH: [RegExp, readonly string[]][] = [
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
]
