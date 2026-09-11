!include "x64.nsh"
!include "WinVer.nsh"
!include "LogicLib.nsh"

!macro munhaeSetupLog TEXT
  Push $0
  ClearErrors
  FileOpen $0 "$TEMP\Munhae-setup.log" a
  ${IfNot} ${Errors}
    FileWrite $0 "${TEXT}$\r$\n"
    FileClose $0
  ${EndIf}
  ClearErrors
  Pop $0
!macroend

!macro customInit
  !insertmacro munhaeSetupLog "Munhae installer started."
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "문해는 Windows 10 이상에서 설치할 수 있습니다."
    SetErrorLevel 1633
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "문해는 64비트(x64) Windows용입니다. 32비트 Windows에서는 설치할 수 없습니다."
    SetErrorLevel 1633
    Abort
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro munhaeSetupLog "Munhae files installed."
!macroend
