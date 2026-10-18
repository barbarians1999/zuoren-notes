import hanYiUrl from './assets/HYShuFang55W.ttf?url';
import fangSongUrl from './assets/ZhaoyeFangSong.ttf?url';

// EPUB documents use blob URLs, so both surfaces need absolute application asset URLs.
export const NOTE_FONT_FACES_CSS = `
  @font-face {
    font-family: "Zuoren HanYi 55W";
    src: url("${new URL(hanYiUrl, document.baseURI).href}") format("truetype");
    font-style: normal;
    font-weight: 400;
    font-display: swap;
  }
  @font-face {
    font-family: "字体管家仿宋体 (非商业使用)";
    src: url("${new URL(fangSongUrl, document.baseURI).href}") format("truetype");
    font-style: normal;
    font-weight: 400;
    font-display: swap;
  }
`;
