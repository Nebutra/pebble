import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2 } from 'lucide-react'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { translate } from '@/i18n/i18n'
import { canMoveTabToNewPaneColumn, moveTabToNewPaneColumn } from './tab-move-to-pane-column'
import { TAB_CONTEXT_SUBMENU_CONTENT_CLASS } from './tab-context-menu-sizing'

const PANE_COLUMN_DIRECTIONS: TabSplitDirection[] = ['right', 'left', 'down', 'up']

function paneColumnDirectionIcon(direction: TabSplitDirection): React.JSX.Element {
  switch (direction) {
    case 'right':
      return <ArrowRight className="mr-1.5 size-3.5 shrink-0" />
    case 'left':
      return <ArrowLeft className="mr-1.5 size-3.5 shrink-0" />
    case 'down':
      return <ArrowDown className="mr-1.5 size-3.5 shrink-0" />
    case 'up':
      return <ArrowUp className="mr-1.5 size-3.5 shrink-0" />
  }
}

function paneColumnDirectionLabel(direction: TabSplitDirection): string {
  switch (direction) {
    case 'right':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.right', 'Right')
    case 'left':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.left', 'Left')
    case 'down':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.down', 'Down')
    case 'up':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.up', 'Up')
  }
}

export function TabWorkspaceLayoutMenuSection({
  unifiedTabId,
  groupId
}: {
  unifiedTabId: string
  groupId: string
}): React.JSX.Element | null {
  if (!canMoveTabToNewPaneColumn(unifiedTabId, groupId)) {
    return null
  }

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="[&>svg:last-child]:size-3.5">
          <Columns2 className="mr-1.5 size-3.5 shrink-0" />
          {translate(
            'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
            'Move Tab to Split'
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className={TAB_CONTEXT_SUBMENU_CONTENT_CLASS}>
          {PANE_COLUMN_DIRECTIONS.map((direction) => (
            <DropdownMenuItem
              key={direction}
              onSelect={() => {
                moveTabToNewPaneColumn({ unifiedTabId, groupId, direction })
              }}
            >
              {paneColumnDirectionIcon(direction)}
              {paneColumnDirectionLabel(direction)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
