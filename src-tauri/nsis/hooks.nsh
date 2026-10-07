; Uninstall hooks for the NSIS installer.
;
; The inbox and the log are ours and live beside the app, so removing them is part
; of removing Piko. There is nothing else: this build has no relay executable and
; stages nothing at launch.
;
; Claude Code's own settings.json is deliberately NOT touched here: it belongs to
; the user, it may contain hooks from other tools, and rewriting somebody's
; config from an uninstaller with no diff and no consent is exactly what the rest
; of this app goes out of its way not to do.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Piko\inbox"
  Delete "$LOCALAPPDATA\Piko\piko.log"
!macroend