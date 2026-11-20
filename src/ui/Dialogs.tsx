import { useApp } from '../app/hooks';
import { CharShapeDialog } from './dialogs/CharShapeDialog';
import { ParaShapeDialog } from './dialogs/ParaShapeDialog';
import { PageSetupDialog, HeaderFooterDialog, PageNumberDialog } from './dialogs/PageDialogs';
import { ColumnsDialog, PageBorderDialog } from './dialogs/LayoutDialogs';
import { RubyDialog, ComposeDialog, ShapeDialog, ClickHereDialog } from './dialogs/InsertDialogs';
import {
  TableDialog,
  LinkDialog,
  SymbolDialog,
  FootnoteDialog,
  GotoDialog,
  CellPropsDialog,
  DocInfoDialog,
  PrefsDialog,
  ShortcutsDialog,
  StyleDialog,
  AboutDialog,
  ConfirmDialog,
  ImageCropDialog,
} from './dialogs/MiscDialogs';
import { McpDialog } from './dialogs/McpDialog';
import { PrivacyDialog } from './dialogs/PrivacyDialog';
import { MathDialog } from './dialogs/MathDialog';
import { CollabDialog } from './dialogs/CollabDialog';
import { TemplateDialog } from './dialogs/TemplateDialog';
import { LegalDialog } from './dialogs/LegalDialog';
import { ContactDialog } from './dialogs/ContactDialog';
import { ObjectDialog } from './dialogs/ObjectDialog';
import { HanjaDialog } from './dialogs/HanjaDialog';

export function Dialogs() {
  const app = useApp();
  const d = app.dialog;
  const close = () => app.closeDialog();
  const needsDoc = d && !['prefs', 'shortcuts', 'about', 'mcp', 'collab', 'template', 'legal', 'contact'].includes(d.type);
  let el: JSX.Element | null = null;
  if (d && (!needsDoc || app.active)) {
    switch (d.type) {
      case 'charShape':
        el = <CharShapeDialog onClose={close} />;
        break;
      case 'paraShape':
        el = <ParaShapeDialog onClose={close} />;
        break;
      case 'pageSetup':
        el = <PageSetupDialog onClose={close} />;
        break;
      case 'headerFooter':
        el = <HeaderFooterDialog onClose={close} />;
        break;
      case 'pageNumber':
        el = <PageNumberDialog onClose={close} />;
        break;
      case 'columns':
        el = <ColumnsDialog onClose={close} />;
        break;
      case 'pageBorder':
        el = <PageBorderDialog onClose={close} />;
        break;
      case 'ruby':
        el = <RubyDialog onClose={close} />;
        break;
      case 'compose':
        el = <ComposeDialog onClose={close} />;
        break;
      case 'shape':
        el = <ShapeDialog onClose={close} />;
        break;
      case 'table':
        el = <TableDialog onClose={close} />;
        break;
      case 'link':
        el = <LinkDialog onClose={close} />;
        break;
      case 'symbol':
        el = <SymbolDialog onClose={close} />;
        break;
      case 'footnote':
        el = <FootnoteDialog onClose={close} pos={d.props?.pos ?? null} text={d.props?.text || ''} />;
        break;
      case 'goto':
        el = <GotoDialog onClose={close} />;
        break;
      case 'cellProps':
        el = <CellPropsDialog onClose={close} />;
        break;
      case 'docInfo':
        el = <DocInfoDialog onClose={close} />;
        break;
      case 'prefs':
        el = <PrefsDialog onClose={close} />;
        break;
      case 'shortcuts':
        el = <ShortcutsDialog onClose={close} />;
        break;
      case 'style':
        el = <StyleDialog onClose={close} />;
        break;
      case 'imageCrop':
        el = <ImageCropDialog onClose={close} />;
        break;
      case 'object':
        el = <ObjectDialog onClose={close} />;
        break;
      case 'clickHere':
        el = <ClickHereDialog onClose={close} />;
        break;
      case 'hanja':
        el = <HanjaDialog onClose={close} from={d.props.from} text={d.props.text} />;
        break;
      case 'about':
        el = <AboutDialog onClose={close} />;
        break;
      case 'mcp':
        el = <McpDialog onClose={close} />;
        break;
      case 'math':
        el = <MathDialog onClose={close} pos={d.props?.pos ?? null} latex={d.props?.latex || ''} hwp={d.props?.hwp || ''} />;
        break;
      case 'contact':
        el = <ContactDialog onClose={close} category={d.props?.category} message={d.props?.message} />;
        break;
      case 'legal':
        el = <LegalDialog onClose={close} kind={d.props?.kind === 'licenses' ? 'licenses' : 'privacy'} />;
        break;
      case 'template':
        el = <TemplateDialog onClose={close} />;
        break;
      case 'collab':
        el = <CollabDialog onClose={close} />;
        break;
      case 'privacy':
        el = <PrivacyDialog onClose={close} />;
        break;
    }
  }
  return (
    <>
      {el && <div key={d!.type + JSON.stringify(d!.props || {})}>{el}</div>}
      <ConfirmDialog />
    </>
  );
}
