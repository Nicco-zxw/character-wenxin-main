; CharacterArc NSIS installer customization
; 防呆：确保安装目录末尾包含产品名文件夹，防止用户直接装在桌面等位置导致卸载异常

!macro customInit
  ${If} $INSTDIR != ""
    ; 如果用户选择的目录末尾不是 CharacterArc，自动追加
    StrLen $0 "$INSTDIR"
    ${If} $0 > 0
      StrCpy $1 "$INSTDIR" "" -12
      ${If} $1 != "CharacterArc"
        StrCpy $INSTDIR "$INSTDIR\CharacterArc"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
