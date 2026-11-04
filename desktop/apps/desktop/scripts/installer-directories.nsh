!include "LogicLib.nsh"

Var ondraFinalDirectory
Var ondraNewDirectory
Var ondraOldDirectory
Var ondraOldMoved
Var ondraNewMoved
Var ondraDirectoryError
Var ondraDirectorySource
Var ondraDirectoryDestination
Var ondraRestoreError
Var ondraDirectoryLogDirectory
Var ondraRecoveryStopped

; MoveFileEx preserves the destination and exposes the Windows error before rollback changes it.
; Open files inside a directory can make its rename return access denied (5).
!macro ondraDirectoryOperation SOURCE DESTINATION RESULT PHASE
  Push $0
  Push $1
  Push $2
  StrCpy $0 0
  ${Do}
    ${If} "${DESTINATION}" == ""
      System::Call 'kernel32::RemoveDirectoryW(w "${SOURCE}") i.r1 ?e'
    ${Else}
      System::Call 'kernel32::MoveFileExW(w "${SOURCE}", w "${DESTINATION}", i 0) i.r1 ?e'
    ${EndIf}
    Pop ${RESULT}
    ${If} "${DESTINATION}" == ""
      ${If} ${RESULT} == 2
      ${OrIf} ${RESULT} == 3
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    ${If} $1 != 0
      StrCpy ${RESULT} 0
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $2 "$PLUGINSDIR\directory-operations.log" a
    ${IfNot} ${Errors}
      FileSeek $2 0 END
      FileWrite $2 "${PHASE}: Windows error: ${RESULT}$\r$\n"
      FileClose $2
    ${EndIf}
    ${If} ${RESULT} != 5
    ${AndIf} ${RESULT} != 32
    ${AndIf} ${RESULT} != 33
      ${ExitDo}
    ${EndIf}
    IntOp $0 $0 + 1
    ${If} $0 >= 10
      ${ExitDo}
    ${EndIf}
    IntOp $1 $0 * 250
    Sleep $1
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro ondraReportDirectoryFailure
  ${If} $ondraRestoreError != 0
    StrCpy $ondraRecoveryStopped "1"
  ${EndIf}
  !ifmacrodef customInstallerDirectoryFailed
    !insertmacro customInstallerDirectoryFailed
  !else
    DetailPrint "Directory operation failed ($ondraDirectoryError): $ondraDirectorySource -> $ondraDirectoryDestination; restore error: $ondraRestoreError"
  !endif
!macroend

!macro ondraExtractPayload FILE
  !ifmacrodef customInstallerExtract
    !insertmacro customInstallerExtract "${FILE}"
  !else
    nsExec::ExecToStack '"$PLUGINSDIR\ondra-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
    Pop $R0
    Pop $R1
  !endif
  ${If} $R0 != 0
    DetailPrint $R1
    Call ondraRollbackDirectories
    !ifmacrodef customInstallerExtractFailed
      !insertmacro customInstallerExtractFailed "${FILE}"
    !else
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
    !endif
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro ondraStageApplication
  !ifdef ONDRA_INSTALLER_LOG_DIR
    ; electron-builder defines the cache name after including our function bodies, before this section expands.
    StrCpy $ondraDirectoryLogDirectory "${ONDRA_INSTALLER_LOG_DIR}"
  !endif
  StrCpy $ondraFinalDirectory $INSTDIR
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $ondraNewDirectory "$INSTDIR.new-$0"
  StrCpy $ondraOldDirectory "$INSTDIR.old-$0"
  StrCpy $ondraOldMoved ""
  StrCpy $ondraNewMoved ""
  StrCpy $ondraDirectoryError 0
  StrCpy $ondraRestoreError 0
  StrCpy $ondraRecoveryStopped ""
  ClearErrors
  CreateDirectory $ondraNewDirectory
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\ondra-7za.exe "${ONDRA_SEVENZIP_PATH}"
  StrCpy $INSTDIR $ondraNewDirectory
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  !ifdef ONDRA_SEVENZIP_LICENSE_DIR
    File /oname=7zip-installer-LICENSE.txt "${ONDRA_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
    File /oname=7zip-installer-COPYING.txt "${ONDRA_SEVENZIP_LICENSE_DIR}\COPYING"
  !endif
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $ondraFinalDirectory
  SetOutPath $PLUGINSDIR
!macroend

Function .onGUIEnd
  Call ondraCleanupDirectories
FunctionEnd

Function ondraCleanupDirectories
  ${If} $ondraRecoveryStopped == "1"
    Return
  ${EndIf}
  ${If} $ondraFinalDirectory != ""
    Call ondraRollbackDirectories
  ${EndIf}
FunctionEnd

; Only directories created or renamed by this installer are removed during rollback.
Function ondraRollbackDirectories
  SetOutPath $PLUGINSDIR
  ${If} $ondraNewMoved == "1"
    RMDir /r "\\?\$ondraFinalDirectory"
    StrCpy $ondraNewMoved ""
  ${EndIf}
  ${If} $ondraOldMoved == "1"
    !insertmacro ondraDirectoryOperation "$ondraOldDirectory" "$ondraFinalDirectory" $ondraRestoreError "restore"
    ${If} $ondraRestoreError != 0
      ; Leave the complete backup in place if another process prevents restoration.
      DetailPrint $ondraOldDirectory
      RMDir /r "\\?\$ondraNewDirectory"
      Return
    ${EndIf}
    StrCpy $ondraOldMoved ""
  ${EndIf}
  ${If} $ondraNewDirectory != ""
    RMDir /r "\\?\$ondraNewDirectory"
  ${EndIf}
  StrCpy $INSTDIR $ondraFinalDirectory
FunctionEnd

Function ondraPromoteDirectories
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 2
  !endif
  ; SetOutPath opens a directory handle; release it before either rename.
  SetOutPath $PLUGINSDIR
  ClearErrors
  ${If} ${FileExists} "$ondraFinalDirectory\*.*"
    StrCpy $ondraDirectorySource $ondraFinalDirectory
    StrCpy $ondraDirectoryDestination $ondraOldDirectory
    !insertmacro ondraDirectoryOperation "$ondraDirectorySource" "$ondraDirectoryDestination" $ondraDirectoryError "backup"
    ${If} $ondraDirectoryError != 0
      Call ondraRollbackDirectories
      !insertmacro ondraReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
    StrCpy $ondraOldMoved "1"
  ${Else}
    ; NSIS can create the destination before the install section starts.
    StrCpy $ondraDirectorySource $ondraFinalDirectory
    StrCpy $ondraDirectoryDestination ""
    !insertmacro ondraDirectoryOperation "$ondraDirectorySource" "" $ondraDirectoryError "remove-empty"
    ${If} $ondraDirectoryError != 0
      Call ondraRollbackDirectories
      !insertmacro ondraReportDirectoryFailure
      SetErrors
      Return
    ${EndIf}
  ${EndIf}
  ClearErrors
  StrCpy $ondraDirectorySource $ondraNewDirectory
  StrCpy $ondraDirectoryDestination $ondraFinalDirectory
  !insertmacro ondraDirectoryOperation "$ondraDirectorySource" "$ondraDirectoryDestination" $ondraDirectoryError "promote"
  ${If} $ondraDirectoryError != 0
    Call ondraRollbackDirectories
    !insertmacro ondraReportDirectoryFailure
    SetErrors
    Return
  ${EndIf}
  StrCpy $ondraNewMoved "1"
  SetOutPath $ondraFinalDirectory
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 3
  !endif
  ClearErrors
FunctionEnd

!macro ondraFinishDirectories
  StrCpy $ondraNewMoved ""
  ${If} $ondraOldMoved == "1"
    RMDir /r "\\?\$ondraOldDirectory"
    StrCpy $ondraOldMoved ""
  ${EndIf}
!macroend
