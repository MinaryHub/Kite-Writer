import { useState } from 'react';
import { app } from '../../app/controller';
import { Modal, OkCancel, Fieldset, NumberInput, ColorField, FontCombo, Seg } from '../widgets';
import { currentFont, currentFontSize } from '../Toolbar';
import { EMPHASIS_CSS, EMPHASIS_LABELS, TEXT_EFFECT_CSS } from '../../editor/extensions/textStyleExt';
import { decoStyle } from '../../editor/extensions/charMarks';

/** 밑줄·취소선의 선 종류 (한글 이름과 표시) */
const LINE_SHAPE_OPTIONS: [string, string][] = [
  ['', '실선'],
  ['DASH', '파선'],
  ['DOT', '점선'],
  ['DASH_DOT', '일점쇄선'],
  ['DASH_DOT_DOT', '이점쇄선'],
  ['LONG_DASH', '긴 파선'],
  ['DOUBLE_SLIM', '이중 실선'],
  ['WAVE', '물결선'],
];

export function CharShapeDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const ts = editor.getAttributes('textStyle');
  const initFont = currentFont(editor);
  const [s, setS] = useState({
    font: currentFont(editor),
    size: currentFontSize(editor),
    color: (ts.color as string) || '#000000',
    highlight: (editor.getAttributes('highlight').color as string) || null,
    letterSpacing: (ts.letterSpacing as number) || 0,
    fontWidth: (ts.fontWidth as number) || 100,
    effect: (ts.textEffect as string) || '',
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    ulShape: (editor.getAttributes('underline').shape as string) || '',
    ulColor: (editor.getAttributes('underline').color as string) || null,
    ulTop: editor.getAttributes('underline').pos === 'top',
    strike: editor.isActive('strike'),
    stShape: (editor.getAttributes('strike').shape as string) || '',
    stColor: (editor.getAttributes('strike').color as string) || null,
    emphasis: (ts.emphasis as string) || '',
    offset: (ts.offset as number) || 0,
    script: editor.isActive('superscript') ? 'sup' : editor.isActive('subscript') ? 'sub' : 'none',
  });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });

  const apply = () => {
    const c = editor.chain().focus();
    c.setTextStyleAttrs({
      fontFamily: s.font,
      // 글꼴을 바꾸면 언어별 글꼴(한글 문서)도 그 글꼴로
      ...(s.font !== initFont ? { langFonts: null } : {}),
      fontSize: s.size,
      color: s.color && s.color !== '#000000' ? s.color : null,
      letterSpacing: s.letterSpacing || null,
      fontWidth: s.fontWidth !== 100 ? s.fontWidth : null,
      textEffect: s.effect || null,
      emphasis: s.emphasis || null,
      offset: s.offset || null,
    });
    s.bold ? c.setBold() : c.unsetBold();
    s.italic ? c.setItalic() : c.unsetItalic();
    // 밑줄·취소선은 종류·색(·위치)을 함께 가진다
    if (s.underline) c.setMark('underline', { shape: s.ulShape || null, color: s.ulColor, pos: s.ulTop ? 'top' : null });
    else c.unsetUnderline();
    if (s.strike) c.setMark('strike', { shape: s.stShape || null, color: s.stColor });
    else c.unsetStrike();
    c.unsetSuperscript().unsetSubscript();
    if (s.script === 'sup') c.setSuperscript();
    if (s.script === 'sub') c.setSubscript();
    if (s.highlight) c.setHighlight({ color: s.highlight });
    else c.unsetHighlight();
    c.run();
    app.rememberFont(s.font);
    onClose();
  };

  const previewStyle: React.CSSProperties = {
    fontFamily: `'${s.font}', serif`,
    fontSize: Math.min(36, s.size * 1.6) + 'px',
    color: s.color,
    background: s.highlight || undefined,
    fontWeight: s.bold ? 'bold' : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: [s.underline && (s.ulTop ? 'overline' : 'underline'), s.strike && 'line-through'].filter(Boolean).join(' ') || undefined,
    textDecorationStyle: (s.underline ? decoStyle(s.ulShape) : s.strike ? decoStyle(s.stShape) : undefined) as React.CSSProperties['textDecorationStyle'],
    textDecorationColor: (s.underline ? s.ulColor : s.strike ? s.stColor : null) || undefined,
    textEmphasis: s.emphasis && EMPHASIS_CSS[s.emphasis] ? EMPHASIS_CSS[s.emphasis][0] : undefined,
    textEmphasisPosition: s.emphasis && EMPHASIS_CSS[s.emphasis] ? `${EMPHASIS_CSS[s.emphasis][1]} right` : undefined,
    position: s.offset ? 'relative' : undefined,
    top: s.offset ? `${s.offset / 100}em` : undefined,
    letterSpacing: s.letterSpacing / 100 + 'em',
    fontStretch: s.fontWidth + '%',
    verticalAlign: s.script === 'sup' ? 'super' : s.script === 'sub' ? 'sub' : undefined,
  };
  const effectCss = s.effect ? TEXT_EFFECT_CSS[s.effect] : '';
  if (effectCss) for (const decl of effectCss.split(';')) {
    const [k, v] = decl.split(':').map((x) => x.trim());
    if (k && v) (previewStyle as any)[k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()).replace(/^Webkit/, 'Webkit')] = v;
  }

  return (
    <Modal title="글자 모양" onClose={onClose} width={520} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <Fieldset legend="기본">
        <div className="form-grid">
          <label>글꼴</label>
          <FontCombo value={s.font} fonts={app.fontList()} onChange={(f) => up({ font: f })} width={220} />
          <label>기준 크기</label>
          <NumberInput value={s.size} onChange={(v) => up({ size: v })} step={0.5} min={1} max={4096} unit="pt" />
          <label>장평</label>
          <NumberInput value={s.fontWidth} onChange={(v) => up({ fontWidth: v })} min={50} max={200} unit="%" />
          <label>자간</label>
          <NumberInput value={s.letterSpacing} onChange={(v) => up({ letterSpacing: v })} min={-50} max={50} unit="%" />
          <label>글자 위치</label>
          <NumberInput value={s.offset} onChange={(v) => up({ offset: v })} min={-100} max={100} unit="%" />
        </div>
      </Fieldset>
      <Fieldset legend="속성">
        <div className="row wrap" style={{ gap: 14, marginBottom: 10 }}>
          <label className="check">
            <input type="checkbox" checked={s.bold} onChange={(e) => up({ bold: e.target.checked })} />
            <b>진하게</b>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.italic} onChange={(e) => up({ italic: e.target.checked })} />
            <i>기울임</i>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.underline} onChange={(e) => up({ underline: e.target.checked })} />
            <u>밑줄</u>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.strike} onChange={(e) => up({ strike: e.target.checked })} />
            <s>취소선</s>
          </label>
        </div>
        <div className="row wrap" style={{ gap: 10, marginBottom: 10 }}>
          <span>효과</span>
          <Seg
            value={s.effect}
            onChange={(v) => up({ effect: v })}
            options={[
              { value: '', label: '없음' },
              { value: 'outline', label: '외곽선' },
              { value: 'shadow', label: '그림자' },
              { value: 'emboss', label: '양각' },
              { value: 'engrave', label: '음각' },
            ]}
          />
        </div>
        {(s.underline || s.strike) && (
          <div className="form-grid" style={{ marginBottom: 10 }}>
            {s.underline && (
              <>
                <label>밑줄 모양</label>
                <div className="row" style={{ gap: 8 }}>
                  <select value={s.ulShape} onChange={(e) => up({ ulShape: e.target.value })}>
                    {LINE_SHAPE_OPTIONS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <ColorField value={s.ulColor} onChange={(v) => up({ ulColor: v })} />
                  <label className="check">
                    <input type="checkbox" checked={s.ulTop} onChange={(e) => up({ ulTop: e.target.checked })} />
                    글자 위에
                  </label>
                </div>
              </>
            )}
            {s.strike && (
              <>
                <label>취소선 모양</label>
                <div className="row" style={{ gap: 8 }}>
                  <select value={s.stShape} onChange={(e) => up({ stShape: e.target.value })}>
                    {LINE_SHAPE_OPTIONS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <ColorField value={s.stColor} onChange={(v) => up({ stColor: v })} />
                </div>
              </>
            )}
          </div>
        )}
        <div className="row" style={{ gap: 10, marginBottom: 10 }}>
          <span>강조점</span>
          <select value={s.emphasis} onChange={(e) => up({ emphasis: e.target.value })}>
            {EMPHASIS_LABELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span>첨자</span>
          <Seg
            value={s.script}
            onChange={(v) => up({ script: v })}
            options={[
              { value: 'none', label: '보통' },
              { value: 'sup', label: '위 첨자' },
              { value: 'sub', label: '아래 첨자' },
            ]}
          />
        </div>
      </Fieldset>
      <Fieldset legend="색">
        <div className="form-grid">
          <label>글자 색</label>
          <ColorField value={s.color} onChange={(v) => up({ color: v || '#000000' })} allowNone={false} />
          <label>음영 색</label>
          <ColorField value={s.highlight} onChange={(v) => up({ highlight: v })} />
        </div>
      </Fieldset>
      <div className="preview-box">
        <span style={previewStyle}>한글 Hangul 123 가나다</span>
      </div>
    </Modal>
  );
}
