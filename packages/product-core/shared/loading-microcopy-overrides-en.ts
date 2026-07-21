// English seed-pattern → phrase overrides, split out of loading-microcopy-overrides.ts.
export const LOADING_MICROCOPY_OVERRIDES_EN: [RegExp, readonly string[]][] = [
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
]
