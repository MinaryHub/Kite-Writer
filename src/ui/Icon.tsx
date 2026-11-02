import {
  AArrowDown, AArrowUp, AlignCenter, AlignHorizontalSpaceAround, AlignJustify, AlignLeft, AlignRight,
  ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, BarChart3, Bold, Calendar,
  ClipboardPaste, ClipboardType, Clock, Code2, Columns2, Columns3, Copy, CornerDownRight, Eye, FileDown,
  FilePlus, FileText, FolderOpen, Hash, Image, IndentDecrease, IndentIncrease, Info, Italic, Keyboard,
  Link, List, ListChecks, ListOrdered, LogOut, Merge, Minus, Omega, PaintBucket, Paintbrush, Palette,
  PanelTop, PanelTopOpen, Pilcrow, Printer, Quote, RectangleHorizontal, Redo2, RemoveFormatting, Replace,
  Rows3, Save, SaveAll, Scissors, Search, SeparatorHorizontal, Settings, SpellCheck, Split, Strikethrough,
  Subscript, Superscript, Table, TextSelect, Trash2, Type, Underline, Undo2, X, ZoomIn, ZoomOut,
  ChevronDown, ChevronUp, ChevronRight, Plus, Highlighter, Baseline, Check, FileType2, ArrowUp, ArrowDown,
  RotateCcw, Maximize2, ArrowLeft, ArrowRight, Crop, Sparkles, Plug, LayoutGrid,
  Moon, Sun, Command, MessageSquare, MessageSquarePlus, History, GitCompare, ShieldCheck, EyeOff, Sigma, Users, CheckCheck, CircleCheck, CircleX, Wand2, PencilLine, ClipboardCheck, FileSearch, Reply, Lock, Landmark, CalendarDays, CalendarRange, Plane, ClipboardList, Receipt, Calculator, IdCard, Newspaper, Megaphone, LayoutTemplate, Heart, Mail, Share2, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  AArrowDown, AArrowUp, AlignCenter, AlignHorizontalSpaceAround, AlignJustify, AlignLeft, AlignRight,
  ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, BarChart3, Bold, Calendar,
  ClipboardPaste, ClipboardType, Clock, Code2, Columns2, Columns3, Copy, CornerDownRight, Eye, FileDown,
  FilePlus, FileText, FolderOpen, Hash, Image, IndentDecrease, IndentIncrease, Info, Italic, Keyboard,
  Link, List, ListChecks, ListOrdered, LogOut, Merge, Minus, Omega, PaintBucket, Paintbrush, Palette,
  PanelTop, PanelTopOpen, Pilcrow, Printer, Quote, RectangleHorizontal, Redo2, RemoveFormatting, Replace,
  Rows3, Save, SaveAll, Scissors, Search, SeparatorHorizontal, Settings, SpellCheck, Split, Strikethrough,
  Subscript, Superscript, Table, TextSelect, Trash2, Type, Underline, Undo2, X, ZoomIn, ZoomOut,
  ChevronDown, ChevronUp, ChevronRight, Plus, Highlighter, Baseline, Check, FileType2, ArrowUp, ArrowDown,
  RotateCcw, Maximize2, ArrowLeft, ArrowRight, Crop, Sparkles, Plug, LayoutGrid,
  Moon, Sun, Command, MessageSquare, MessageSquarePlus, History, GitCompare, ShieldCheck, EyeOff, Sigma, Users, CheckCheck, CircleCheck, CircleX, Wand2, PencilLine, ClipboardCheck, FileSearch, Reply, Lock, Landmark, CalendarDays, CalendarRange, Plane, ClipboardList, Receipt, Calculator, IdCard, Newspaper, Megaphone, LayoutTemplate, Heart, Mail, Share2,
};

export function Icon({ name, size = 16, color, strokeWidth = 1.7 }: { name?: string; size?: number; color?: string; strokeWidth?: number }) {
  if (!name) return null;
  const C = ICONS[name];
  if (!C) return null;
  return <C size={size} color={color} strokeWidth={strokeWidth} />;
}
