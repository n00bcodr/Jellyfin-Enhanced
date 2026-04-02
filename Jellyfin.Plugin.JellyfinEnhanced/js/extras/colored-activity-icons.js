// /js/extras/colored-activity-icons.js
// Replaces activity icons with Material Design icons and adds colors

(function() {
    'use strict';

    // Inject CSS to hide original SVG icons ONLY in Activity & Alerts
    function injectCSS() {
        const styleId = 'activity-icons-hide-svg';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
        a[href^="#/dashboard/activity"] .MuiAvatar-root > svg {
          display: none !important;
        }
        a[href^="#/dashboard/activity"] .MuiAvatar-root .material-icons {
          font-family: 'Material Icons';
          font-size: 18px;
          line-height: 1;
          display: inline-block;
          -webkit-font-smoothing: antialiased;
        }
        a[href^="#/dashboard/activity"] .MuiAvatar-root {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          color: #fff !important;
        }
      `;
        document.head.appendChild(style);
    }

    function normalizeActivityText(text) {
        return text.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function buildActivityPattern(parts) {
        const normalizedParts = parts
            .map(normalizeActivityText)
            .filter(Boolean)
            .map(escapeRegExp);

        return new RegExp(normalizedParts.join('.+?'));
    }

    // Activity log matching is based on ordered static parts from localized strings.
    // Variables inserted by Jellyfin (for example {0}, {1}, {2}) are matched by wildcard gaps.
    const ICON_MAP = [
        // English
        { parts: ["successfully authenticated"], icon: "key", color: "#2e4ed6" },
        { parts: ["Failed login attempt from"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["installation failed"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["was installed"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["was uninstalled"], icon: "delete", color: "#c3342a" },
        { parts: ["was updated"], icon: "update", color: "#00bcd4" },
        { parts: ["User", "has been created"], icon: "plus", color: "#2ed62eff" },
        { parts: ["User", "has been deleted"], icon: "person_remove", color: "#c3342a" },
        { parts: ["is downloading"], icon: "download", color: "#607d8b" },
        { parts: ["User", "has been locked out"], icon: "block", color: "#f44336" },
        { parts: ["has disconnected from"], icon: "logout", color: "#be7404" },
        { parts: ["is online from"], icon: "login", color: "green" },
        { parts: ["Password has been changed for user"], icon: "key", color: "#ada130ff" },
        { parts: ["is playing", "on"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["has finished playing", "on"], icon: "check_circle", color: "#4caf50" },
        { parts: ["failed"], icon: "error", color: "#ff6e40" },
        { parts: ["Subtitles failed to download from", "for"], icon: "error", color: "#ff6e40" },

        // Catalan
        { parts: ["s'ha autenticat correctament"], icon: "key", color: "#2e4ed6" },
        { parts: ["Intent de connexió fallit des de"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["instal·lació fallida"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["ha estat instal·lat"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["S'ha instal·lat"], icon: "delete", color: "#c3342a" },
        { parts: ["S'ha actualitzat"], icon: "update", color: "#00bcd4" },
        { parts: ["S'ha creat l'usuari"], icon: "plus", color: "#2ed62eff" },
        { parts: ["S'ha eliminat l'usuari"], icon: "person_remove", color: "#c3342a" },
        { parts: ["està descarregant"], icon: "download", color: "#607d8b" },
        { parts: ["S'ha expulsat a l'usuari"], icon: "block", color: "#f44336" },
        { parts: ["s'ha desconnectat de"], icon: "logout", color: "#be7404" },
        { parts: ["està connectat des de"], icon: "login", color: "green" },
        { parts: ["S'ha canviat la contrasenya per a l'usuari"], icon: "key", color: "#ada130ff" },
        { parts: ["ha començat a reproduir", "a"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["ha parat de reproduir", "a"], icon: "check_circle", color: "#4caf50" },
        { parts: ["ha fallat"], icon: "error", color: "#ff6e40" },
        { parts: ["Els subtítols per a", "no s'han pogut baixar de"], icon: "error", color: "#ff6e40" },

        // Polish
        { parts: ["został pomyślnie uwierzytelniony"], icon: "key", color: "#2e4ed6" },
        { parts: ["Nieudana próba logowania przez"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["Instalacja", "nieudana"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["zostało zainstalowane"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["odinstalowane"], icon: "delete", color: "#c3342a" },
        { parts: ["zaktualizowane"], icon: "update", color: "#00bcd4" },
        { parts: ["Użytkownik", "został utworzony"], icon: "plus", color: "#2ed62eff" },
        { parts: ["Użytkownik", "został usunięty"], icon: "person_remove", color: "#c3342a" },
        { parts: ["pobiera"], icon: "download", color: "#607d8b" },
        { parts: ["Użytkownik", "został zablokowany"], icon: "block", color: "#f44336" },
        { parts: ["z", "został rozłączony"], icon: "logout", color: "#be7404" },
        { parts: ["połączył się z"], icon: "login", color: "green" },
        { parts: ["Hasło użytkownika", "zostało zmienione"], icon: "key", color: "#ada130ff" },
        { parts: ["odtwarza", "na"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["zakończył odtwarzanie", "na"], icon: "check_circle", color: "#4caf50" },
        { parts: ["Nieudane"], icon: "error", color: "#ff6e40" },
        { parts: ["Nieudane pobieranie napisów z", "dla"], icon: "error", color: "#ff6e40" },

        // German
        { parts: ["erfolgreich authentifiziert"], icon: "key", color: "#2e4ed6" },
        { parts: ["Anmeldung von", "fehlgeschlagen"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["Installation von", "fehlgeschlagen"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["wurde installiert"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["wurde deinstalliert"], icon: "delete", color: "#c3342a" },
        { parts: ["wurde aktualisiert"], icon: "update", color: "#00bcd4" },
        { parts: ["Benutzer", "wurde erstellt"], icon: "plus", color: "#2ed62eff" },
        { parts: ["Benutzer", "wurde gelöscht"], icon: "person_remove", color: "#c3342a" },
        { parts: ["lädt", "herunter"], icon: "download", color: "#607d8b" },
        { parts: ["Benutzer", "wurde gesperrt"], icon: "block", color: "#f44336" },
        { parts: ["wurde getrennt von"], icon: "logout", color: "#be7404" },
        { parts: ["ist online von"], icon: "login", color: "green" },
        { parts: ["Das Passwort für Benutzer", "wurde geändert"], icon: "key", color: "#ada130ff" },
        { parts: ["hat die Wiedergabe von", "auf", "gestartet"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["hat die Wiedergabe von", "auf", "beendet"], icon: "check_circle", color: "#4caf50" },
        { parts: ["ist fehlgeschlagen"], icon: "error", color: "#ff6e40" },
        { parts: ["Untertitel von", "für", "konnten nicht heruntergeladen werden"], icon: "error", color: "#ff6e40" },

        // French
        { parts: ["authentifié avec succès"], icon: "key", color: "#2e4ed6" },
        { parts: ["Échec de connexion depuis"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["échec de l'installation"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["a été installé"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["a été désinstallé"], icon: "delete", color: "#c3342a" },
        { parts: ["a été mis à jour"], icon: "update", color: "#00bcd4" },
        { parts: ["L'utilisateur", "a été créé"], icon: "plus", color: "#2ed62eff" },
        { parts: ["L'utilisateur", "a été supprimé"], icon: "person_remove", color: "#c3342a" },
        { parts: ["est en train de télécharger"], icon: "download", color: "#607d8b" },
        { parts: ["L'utilisateur", "a été verrouillé"], icon: "block", color: "#f44336" },
        { parts: ["s'est déconnecté depuis"], icon: "logout", color: "#be7404" },
        { parts: ["s'est connecté depuis"], icon: "login", color: "green" },
        { parts: ["Le mot de passe pour l'utilisateur", "a été modifié"], icon: "key", color: "#ada130ff" },
        { parts: ["est en train de lire", "sur"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["vient d'arrêter la lecture de", "sur"], icon: "check_circle", color: "#4caf50" },
        { parts: ["a échoué"], icon: "error", color: "#ff6e40" },
        { parts: ["Échec du téléchargement des sous-titres depuis", "pour"], icon: "error", color: "#ff6e40" },

        // Spanish
        { parts: ["autenticado correctamente"], icon: "key", color: "#2e4ed6" },
        { parts: ["Intento fallido de inicio de sesión de"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["error de instalación"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["se ha instalado"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["se ha desinstalado"], icon: "delete", color: "#c3342a" },
        { parts: ["se actualizó"], icon: "update", color: "#00bcd4" },
        { parts: ["El usuario", "ha sido creado"], icon: "plus", color: "#2ed62eff" },
        { parts: ["El usuario", "ha sido borrado"], icon: "person_remove", color: "#c3342a" },
        { parts: ["está descargando"], icon: "download", color: "#607d8b" },
        { parts: ["El usuario", "ha sido bloqueado"], icon: "block", color: "#f44336" },
        { parts: ["se ha desconectado desde"], icon: "logout", color: "#be7404" },
        { parts: ["está en línea desde"], icon: "login", color: "green" },
        { parts: ["Se ha cambiado la contraseña para el usuario"], icon: "key", color: "#ada130ff" },
        { parts: ["está reproduciendo", "en"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["ha terminado de reproducir", "en"], icon: "check_circle", color: "#4caf50" },
        { parts: ["falló"], icon: "error", color: "#ff6e40" },
        { parts: ["Fallo en la descarga de subtítulos desde", "para"], icon: "error", color: "#ff6e40" },

        // Italian
        { parts: ["autenticato correttamente"], icon: "key", color: "#2e4ed6" },
        { parts: ["Tentativo di accesso non riuscito da"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["installazione non riuscita"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["è stato installato"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["è stato disinstallato"], icon: "delete", color: "#c3342a" },
        { parts: ["è stato aggiornato"], icon: "update", color: "#00bcd4" },
        { parts: ["L'utente", "è stato creato"], icon: "plus", color: "#2ed62eff" },
        { parts: ["L'utente", "è stato eliminato"], icon: "person_remove", color: "#c3342a" },
        { parts: ["sta scaricando"], icon: "download", color: "#607d8b" },
        { parts: ["L'utente", "è stato bloccato"], icon: "block", color: "#f44336" },
        { parts: ["si è disconnesso da"], icon: "logout", color: "#be7404" },
        { parts: ["è online su"], icon: "login", color: "green" },
        { parts: ["La password è stata cambiata per l'utente"], icon: "key", color: "#ada130ff" },
        { parts: ["ha avviato la riproduzione di", "su"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["ha interrotto la riproduzione di", "su"], icon: "check_circle", color: "#4caf50" },
        { parts: ["non riuscito"], icon: "error", color: "#ff6e40" },
        { parts: ["Impossibile scaricare i sottotitoli da", "per"], icon: "error", color: "#ff6e40" },

        // Japanese
        { parts: ["認証に成功しました"], icon: "key", color: "#2e4ed6" },
        { parts: ["からのログインに失敗しました"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["のインストールに失敗しました"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["をインストールしました"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["をアンインストールしました"], icon: "delete", color: "#c3342a" },
        { parts: ["を更新しました"], icon: "update", color: "#00bcd4" },
        { parts: ["ユーザー", "が作成されました"], icon: "plus", color: "#2ed62eff" },
        { parts: ["User", "を削除しました"], icon: "person_remove", color: "#c3342a" },
        { parts: ["が", "をダウンロードしています"], icon: "download", color: "#607d8b" },
        { parts: ["ユーザー", "はロックされています"], icon: "block", color: "#f44336" },
        { parts: ["は", "から切断しました"], icon: "logout", color: "#be7404" },
        { parts: ["は", "からオンラインになりました"], icon: "login", color: "green" },
        { parts: ["ユーザー", "のパスワードは変更されました"], icon: "key", color: "#ada130ff" },
        { parts: ["は", "で", "を再生しています"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["は", "で", "の再生が終わりました"], icon: "check_circle", color: "#4caf50" },
        { parts: ["が失敗しました"], icon: "error", color: "#ff6e40" },
        { parts: ["から", "の字幕のダウンロードに失敗しました"], icon: "error", color: "#ff6e40" },

        // Russian
        { parts: ["- авторизация успешна"], icon: "key", color: "#2e4ed6" },
        { parts: ["Неудачная попытка входа с"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["Установка", "неудачна"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["- было установлено"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["- было удалено"], icon: "delete", color: "#c3342a" },
        { parts: ["- было обновлено"], icon: "update", color: "#00bcd4" },
        { parts: ["Пользователь", "был создан"], icon: "plus", color: "#2ed62eff" },
        { parts: ["Пользователь", "был удалён"], icon: "person_remove", color: "#c3342a" },
        { parts: ["загружает"], icon: "download", color: "#607d8b" },
        { parts: ["Пользователь", "был заблокирован"], icon: "block", color: "#f44336" },
        { parts: ["отключился с"], icon: "logout", color: "#be7404" },
        { parts: ["подключился с"], icon: "login", color: "green" },
        { parts: ["Пароль пользователя", "был изменён"], icon: "key", color: "#ada130ff" },
        { parts: ["- воспроизведение «", "» на"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["- воспроизведение остановлено «", "» на"], icon: "check_circle", color: "#4caf50" },
        { parts: ["- неудачна"], icon: "error", color: "#ff6e40" },
        { parts: ["Субтитры к", "не удалось загрузить с"], icon: "error", color: "#ff6e40" },

        // Portuguese (Brazilian)
        { parts: ["autenticado com sucesso"], icon: "key", color: "#2e4ed6" },
        { parts: ["Falha na tentativa de login de"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["A instalação de", "falhou"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["foi instalado"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["foi desinstalado"], icon: "delete", color: "#c3342a" },
        { parts: ["foi atualizado"], icon: "update", color: "#00bcd4" },
        { parts: ["O usuário", "foi criado"], icon: "plus", color: "#2ed62eff" },
        { parts: ["O usuário", "foi excluído"], icon: "person_remove", color: "#c3342a" },
        { parts: ["está baixando"], icon: "download", color: "#607d8b" },
        { parts: ["Usuário", "foi bloqueado"], icon: "block", color: "#f44336" },
        { parts: ["se desconectou de"], icon: "logout", color: "#be7404" },
        { parts: ["está online em"], icon: "login", color: "green" },
        { parts: ["A senha foi alterada para o usuário"], icon: "key", color: "#ada130ff" },
        { parts: ["está reproduzindo", "em"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["parou de reproduzir", "em"], icon: "check_circle", color: "#4caf50" },
        { parts: ["falhou"], icon: "error", color: "#ff6e40" },
        { parts: ["Houve um problema ao baixar as legendas de", "para"], icon: "error", color: "#ff6e40" },

        // Dutch
        { parts: ["is succesvol geauthenticeerd"], icon: "key", color: "#2e4ed6" },
        { parts: ["Mislukte aanmeldpoging van"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["installatie mislukt"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["is geïnstalleerd"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["is verwijderd"], icon: "delete", color: "#c3342a" },
        { parts: ["is bijgewerkt"], icon: "update", color: "#00bcd4" },
        { parts: ["Gebruiker", "is aangemaakt"], icon: "plus", color: "#2ed62eff" },
        { parts: ["Gebruiker", "is verwijderd"], icon: "person_remove", color: "#c3342a" },
        { parts: ["downloadt"], icon: "download", color: "#607d8b" },
        { parts: ["Gebruiker", "is buitengesloten"], icon: "block", color: "#f44336" },
        { parts: ["Verbinding van", "via", "is verbroken"], icon: "logout", color: "#be7404" },
        { parts: ["is verbonden via"], icon: "login", color: "green" },
        { parts: ["Wachtwoord voor", "is gewijzigd"], icon: "key", color: "#ada130ff" },
        { parts: ["speelt", "af op"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["heeft afspelen van", "gestopt op"], icon: "check_circle", color: "#4caf50" },
        { parts: ["is mislukt"], icon: "error", color: "#ff6e40" },
        { parts: ["Ondertiteling kon niet gedownload worden van", "voor"], icon: "error", color: "#ff6e40" },

        // Korean
        { parts: ["사용자가 성공적으로 인증됨"], icon: "key", color: "#2e4ed6" },
        { parts: ["에서 로그인 실패"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["설치 실패"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["설치됨"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["제거됨"], icon: "delete", color: "#c3342a" },
        { parts: ["업데이트됨"], icon: "update", color: "#00bcd4" },
        { parts: ["사용자", "생성됨"], icon: "plus", color: "#2ed62eff" },
        { parts: ["사용자", "삭제됨"], icon: "person_remove", color: "#c3342a" },
        { parts: ["사용자가", "다운로드 중"], icon: "download", color: "#607d8b" },
        { parts: ["사용자 잠김"], icon: "block", color: "#f44336" },
        { parts: ["사용자의", "에서 연결이 끊김"], icon: "logout", color: "#be7404" },
        { parts: ["사용자가", "에서 접속함"], icon: "login", color: "green" },
        { parts: ["사용자 비밀번호 변경됨"], icon: "key", color: "#ada130ff" },
        { parts: ["사용자의", "에서", "재생 중"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["사용자의", "에서", "재생을 마침"], icon: "check_circle", color: "#4caf50" },
        { parts: ["실패"], icon: "error", color: "#ff6e40" },
        { parts: ["에서", "자막 다운로드에 실패했습니다"], icon: "error", color: "#ff6e40" },

        // Swedish
        { parts: ["har autentiserats"], icon: "key", color: "#2e4ed6" },
        { parts: ["Misslyckat inloggningsförsök från"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["installationen misslyckades"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["installerades"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["avinstallerades"], icon: "delete", color: "#c3342a" },
        { parts: ["uppdaterades"], icon: "update", color: "#00bcd4" },
        { parts: ["Användaren", "har skapats"], icon: "plus", color: "#2ed62eff" },
        { parts: ["Användaren", "har tagits bort"], icon: "person_remove", color: "#c3342a" },
        { parts: ["laddar ner"], icon: "download", color: "#607d8b" },
        { parts: ["Användare", "har utelåsts"], icon: "block", color: "#f44336" },
        { parts: ["har kopplat ned från"], icon: "logout", color: "#be7404" },
        { parts: ["är uppkopplad från"], icon: "login", color: "green" },
        { parts: ["Lösenordet för", "har ändrats"], icon: "key", color: "#ada130ff" },
        { parts: ["spelar", "på"], icon: "play_arrow", color: "#2196f3" },
        { parts: ["har stoppat uppspelningen av", "på"], icon: "check_circle", color: "#4caf50" },
        { parts: ["misslyckades"], icon: "error", color: "#ff6e40" },
        { parts: ["Undertexter kunde inte laddas ner från", "till"], icon: "error", color: "#ff6e40" },

        // Turkish
        { parts: ["kimliği başarıyla doğrulandı"], icon: "key", color: "#2e4ed6" },
        { parts: ["kullanıcısının başarısız oturum açma girişimi"], icon: "security_update_warning", color: "#f44336" },
        { parts: ["kurulumu başarısız"], icon: "warning", color: "#ee3b3bff" },
        { parts: ["yüklendi"], icon: "inventory_2", color: "#c957ddff" },
        { parts: ["kaldırıldı"], icon: "delete", color: "#c3342a" },
        { parts: ["güncellendi"], icon: "update", color: "#00bcd4" },
        { parts: ["kullanıcısı oluşturuldu"], icon: "plus", color: "#2ed62eff" },
        { parts: ["kullanıcısı silindi"], icon: "person_remove", color: "#c3342a" },
        { parts: ["kullanıcısı", "medyasını indiriyor"], icon: "download", color: "#607d8b" },
        { parts: ["adlı kullanıcı hesabı kilitlendi"], icon: "block", color: "#f44336" },
        { parts: ["kullanıcısının", "ile bağlantısı kesildi"], icon: "logout", color: "#be7404" },
        { parts: ["kullanıcısı", "ile çevrimiçi"], icon: "login", color: "green" },
        { parts: ["kullanıcısının parolası değiştirildi"], icon: "key", color: "#ada130ff" },
        { parts: [",", "cihazında", "izliyor"], icon: "play_arrow", color: "#2196f3" },
        { parts: [",", "cihazında", "izlemeyi bitirdi"], icon: "check_circle", color: "#4caf50" },
        { parts: ["başarısız oldu"], icon: "error", color: "#ff6e40" },
        { parts: ["için altyazılar", "sağlayıcısından indirilemedi"], icon: "error", color: "#ff6e40" }
    ].map(item => ({
        ...item,
        pattern: buildActivityPattern(item.parts)
    }));

    let isProcessing = false;
    let observer = null;
    let debounceTimer = null;

    function updateActivityIcons() {
        if (isProcessing) return;
        isProcessing = true;

        try {
            // Check if activity links are visible
            const activityLinks = document.querySelectorAll('a[href^="#/dashboard/activity"]');

            if (activityLinks.length === 0) {
                isProcessing = false;
                return;
            }

            activityLinks.forEach(anchor => {
                const textEl = anchor.querySelector('.MuiTypography-body1');
                const avatar = anchor.querySelector('.MuiAvatar-root');

                if (!textEl || !avatar) return;

                const text = normalizeActivityText(textEl.textContent);
                const match = ICON_MAP.find(item => item.pattern.test(text));

                if (!match) return;

                // Mark as processed to avoid re-processing
                const dataAttr = 'data-jellyfin-enhanced-activity-icon';
                if (avatar.hasAttribute(dataAttr)) {
                    const existing = avatar.querySelector('.material-icons');
                    if (existing?.textContent === match.icon &&
                        avatar.style.backgroundColor === match.color) return;
                }

                avatar.innerHTML = `<span class="material-icons">${match.icon}</span>`;
                avatar.style.setProperty('background-color', match.color, 'important');
                avatar.setAttribute(dataAttr, 'true');
            });
        } finally {
            isProcessing = false;
        }
    }

    function debouncedUpdateActivityIcons() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateActivityIcons, 100);
    }

    function startMonitoring() {
        if (observer) return;

        const callback = (mutations) => {
            let shouldProcess = false;

            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    const target = mutation.target;

                    // Check if activity links section was modified
                    if (target.matches && (
                        target.matches('a[href^="#/dashboard/activity"]') ||
                        target.querySelector('a[href^="#/dashboard/activity"]') ||
                        target.closest('a[href^="#/dashboard/activity"]')
                    )) {
                        shouldProcess = true;
                    }

                    // Check for activity page container changes
                    if (target.classList && (target.classList.contains('dashboardDocument') || target.classList.contains('activityPage'))) {
                        shouldProcess = true;
                    }
                }
            });

            if (shouldProcess) {
                debouncedUpdateActivityIcons();
            }
        };

        const JE = window.JellyfinEnhanced;
        if (JE?.helpers?.onBodyMutation) {
            observer = JE.helpers.onBodyMutation('colored-activity-icons', callback);
        } else {
            const mo = new MutationObserver(callback);
            mo.observe(document.body, { childList: true, subtree: true });
            observer = { unsubscribe() { mo.disconnect(); } };
        }
    }

    function stopMonitoring() {
        if (observer) {
            observer.unsubscribe();
            observer = null;
        }
    }

    function initialize() {
        // Inject CSS for Material Icons
        injectCSS();
        updateActivityIcons();
        startMonitoring();

        // Re-process icons when navigating to activity page or configuration page
        window.addEventListener('hashchange', (event) => {
            const hash = window.location.hash;
            if (hash.includes('#/dashboard/activity') || hash.includes('#/configurationpage')) {
                // Use a longer timeout to ensure page is rendered
                setTimeout(updateActivityIcons, 300);
            }
        });
    }

    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializeActivityIcons = initialize;
        window.JellyfinEnhanced.stopActivityIconsMonitoring = stopMonitoring;
    }

})();
