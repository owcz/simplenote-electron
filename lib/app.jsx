import React, { PropTypes } from 'react';
import { bindActionCreators } from 'redux'
import { connect } from 'react-redux'
import appState from './flux/app-state'
import {
	reset as resetAuthAction,
	setAuthorized as setAuthorizedAction,
} from './state/auth/actions';
import {
	authIsPending as authIsPendingSelector,
	isAuthorized as isAuthorizedSelector,
} from './state/auth/selectors';
import { getSelectedTag } from './state/tags/selectors';
import { getSelectedCollection } from './state/ui/selectors';
import browserShell from './browser-shell'
import { ContextMenu, MenuItem, Separator } from './context-menu';
import * as Dialogs from './dialogs/index'
import exportNotes from './utils/export';
import exportToZip from './utils/export/to-zip';
import NoteInfo from './note-info'
import NoteList from './note-list'
import NoteEditor	from './note-editor'
import SearchField from './search-field'
import NavigationBar from './navigation-bar'
import Auth from './auth'
import NewNoteIcon from './icons/new-note'
import TagsIcon from './icons/tags'
import NoteDisplayMixin from './note-display-mixin'
import analytics from './analytics'
import classNames	from 'classnames'
import {
	compact,
	concat,
	flowRight,
	noop,
	get,
	has,
	isObject,
	map,
	matchesProperty,
	overEvery,
	pick,
	values,
} from 'lodash';

import * as settingsActions from './state/settings/actions';

import filterNotes from './utils/filter-notes';

// Electron-specific mocks
let ipc = getIpc();
let fs = null;

function getIpc() {
	try {
		ipc = __non_webpack_require__( 'electron' ).ipcRenderer;
	} catch ( e ) {
		ipc = {
			on: noop,
			removeListener: noop,
			send: noop
		};
	}

	return ipc;
}

const mapStateToProps = state => ( {
	...state,
	authIsPending: authIsPendingSelector( state ),
	isAuthorized: isAuthorizedSelector( state ),
	selectedCollection: getSelectedCollection( state ),
	selectedTag: getSelectedTag( state ),
} );

function mapDispatchToProps( dispatch, { noteBucket } ) {
	var actionCreators = Object.assign( {},
		appState.actionCreators
	);

	const thenReloadNotes = action => a => {
		dispatch( action( a ) );
		dispatch( actionCreators.loadNotes( { noteBucket } ) );
	};

	return {
		actions: bindActionCreators( actionCreators, dispatch ),
		...bindActionCreators( pick( settingsActions, [
			'activateTheme',
			'decreaseFontSize',
			'increaseFontSize',
			'resetFontSize',
			'setNoteDisplay',
			'setMarkdown',
			'setAccountName'
		] ), dispatch ),
		setSortType: thenReloadNotes( settingsActions.setSortType ),
		toggleSortOrder: thenReloadNotes( settingsActions.toggleSortOrder ),

		resetAuth: () => dispatch( resetAuthAction() ),
		selectAllNotes: () => dispatch( actionCreators.selectAllNotes() ),
		selectTrashedNotes: () => dispatch( actionCreators.selectTrash() ),
		setAuthorized: () => dispatch( setAuthorizedAction() ),
	};
}

const isElectron = ( () => {
	// https://github.com/atom/electron/issues/2288
	const foundElectron = has( window, 'process.type' );

	if ( foundElectron ) {
		fs = __non_webpack_require__( 'fs' );
	}

	return () => foundElectron;
} )();

const isElectronMac = () => matchesProperty( 'process.platform', 'darwin' )( window );

export const App = connect( mapStateToProps, mapDispatchToProps )( React.createClass( {

	mixins: [NoteDisplayMixin],

	propTypes: {
		actions: PropTypes.object.isRequired,
		appState: PropTypes.object.isRequired,
		settings: PropTypes.object.isRequired,

		client: PropTypes.object.isRequired,
		noteBucket: PropTypes.object.isRequired,
		tagBucket: PropTypes.object.isRequired,
		onAuthenticate: PropTypes.func.isRequired,
		onSignOut: PropTypes.func.isRequired,
	},

	getDefaultProps: function() {
		return {
			onAuthenticate: () => {},
			onSignOut: () => {}
		};
	},

	componentWillMount: function() {
		if ( isElectron() ) {
			this.initializeElectron();
		}

		this.onAuthChanged();
	},

	componentDidMount: function() {
		ipc.on( 'appCommand', this.onAppCommand );
		ipc.send( 'settingsUpdate', this.props.settings );

		this.props.noteBucket
			.on( 'index', this.onNotesIndex )
			.on( 'update', this.onNoteUpdate )
			.on( 'remove', this.onNoteRemoved );

		this.props.tagBucket
			.on( 'index', this.onTagsIndex )
			.on( 'update', this.onTagsIndex )
			.on( 'remove', this.onTagsIndex );

		this.props.client
			.on( 'authorized', this.onAuthChanged )
			.on( 'unauthorized', this.onAuthChanged );

		this.onNotesIndex();
		this.onTagsIndex();

		analytics.tracks.recordEvent( 'application_opened' );
	},

	componentWillUnmount: function() {
		ipc.removeListener( 'appCommand', this.onAppCommand );
	},

	componentDidUpdate( prevProps ) {
		if ( this.props.settings !== prevProps.settings ) {
			ipc.send( 'settingsUpdate', this.props.settings );
		}
	},

	onAppCommand: function( event, command ) {
		if ( 'exportZipArchive' === get( command, 'action' ) ) {
			return exportNotes()
				.then( exportToZip )
				.then( zip => zip.generateAsync( {
					compression: 'DEFLATE',
					platform: get( window, 'process.platform', 'DOS' ),
					type: 'base64',
				} ) )
				.then( blob => fs.writeFile( command.filename, blob, 'base64' ) )
				.catch( console.log );
		}

		const canRun = overEvery(
			isObject,
			o => o.action !== null,
			o => has( this.props.actions, o.action ) || has( this.props, o.action )
		);

		if ( canRun( command ) ) {
			// newNote expects a bucket to be passed in, but the action method itself wouldn't do that
			if ( command.action === 'newNote' ) {
				this.onNewNote();
			} else if ( has( this.props, command.action ) ) {
				const { action, ...args } = command;

				this.props[ action ]( ...values( args ) );
			} else {
				this.props.actions[ command.action ]( command );
			}
		}
	},

	onAuthChanged() {
		const {
			actions,
			appState: { accountName },
			client,
			resetAuth,
			setAuthorized,
		} = this.props;

		actions.authChanged();

		if ( ! client.isAuthorized() ) {
			return resetAuth();
		}

		setAuthorized();
		analytics.initialize( accountName );
	},

	onNotePrinted: function() {
		this.props.actions.setShouldPrintNote( {
			shouldPrint: false
		} );
	},

	onSearchFocused: function() {
		this.props.actions.setSearchFocus( {
			searchFocus: false
		} );
	},

	onNotesIndex: function() {
		this.props.actions.loadNotes( {
			noteBucket: this.props.noteBucket
		} );
	},

	onNoteRemoved: function() {
		this.onNotesIndex();
	},

	onNewNote: function() {
		this.props.actions.newNote( {
			noteBucket: this.props.noteBucket
		} );
		analytics.tracks.recordEvent( 'list_note_created' );
	},

	onNoteUpdate: function( noteId, data, original, patch, isIndexing ) {
		this.props.actions.noteUpdated( {
			noteBucket: this.props.noteBucket,
			noteId, data, original, patch, isIndexing
		} );
	},

	onTagsIndex: function() {
		this.props.actions.loadTags( {
			tagBucket: this.props.tagBucket
		} );
	},

	onSelectTag: function( tag ) {
		this.props.actions.selectTag( { tag } );
		analytics.tracks.recordEvent( 'list_tag_viewed' );
	},

	onSettings: function() {
		this.props.actions.showDialog( {
			dialog: {
				type: 'Settings',
				modal: true,
				single: true
			}
		} );
	},

	onAbout: function() {
		this.props.actions.showDialog( {
			dialog: {
				type: 'About',
				modal: true,
				single: true
			}
		} );
	},

	onRenameTag: function( tag, name ) {
		this.props.actions.renameTag( {
			tagBucket: this.props.tagBucket,
			noteBucket: this.props.noteBucket,
			tag, name
		} );
	},

	onTrashTag: function( tag ) {
		this.props.actions.trashTag( {
			tagBucket: this.props.tagBucket,
			noteBucket: this.props.noteBucket,
			tag
		} );
		analytics.tracks.recordEvent( 'list_trash_viewed' );
	},

	onReorderTags: function( tags ) {
		this.props.actions.reorderTags( {
			tagBucket: this.props.tagBucket,
			tags
		} );
	},

	onSearch: function( filter ) {
		this.props.actions.search( { filter } );
		analytics.tracks.recordEvent( 'list_notes_searched' );
	},

	initializeElectron() {
		const remote = __non_webpack_require__( 'electron' ).remote;

		this.setState( {
			electron: {
				currentWindow: remote.getCurrentWindow(),
				Menu: remote.Menu
			}
		} );
	},

	onSetEditorMode: function( mode ) {
		this.props.actions.setEditorMode( { mode } );
	},

	onUpdateContent: function( note, content ) {
		this.props.actions.updateNoteContent( {
			noteBucket: this.props.noteBucket,
			note, content
		} );
	},

	onUpdateNoteTags: function( note, tags ) {
		this.props.actions.updateNoteTags( {
			noteBucket: this.props.noteBucket,
			tagBucket: this.props.tagBucket,
			note, tags
		} );
	},

	onTrashNote: function( note ) {
		const previousIndex = this.getPreviousNoteIndex( note );
		this.props.actions.trashNote( {
			noteBucket: this.props.noteBucket,
			note,
			previousIndex
		} );
		analytics.tracks.recordEvent( 'editor_note_deleted' );
	},

	// gets the index of the note located before the currently selected one
	getPreviousNoteIndex: function( note ) {
		const filteredNotes = filterNotes( this.props.appState );

		const noteIndex = function( filteredNote ) {
			return note.id === filteredNote.id;
		};

		return Math.max( filteredNotes.findIndex( noteIndex ) - 1, 0 );
	},

	onRestoreNote: function( note ) {
		const previousIndex = this.getPreviousNoteIndex( note );
		this.props.actions.restoreNote( {
			noteBucket: this.props.noteBucket,
			note,
			previousIndex
		} );
		analytics.tracks.recordEvent( 'editor_note_restored' );
	},

	onShareNote: function( note ) {
		this.props.actions.showDialog( {
			dialog: {
				type: 'Share',
				modal: true
			},
			params: { note }
		} );
	},

	onDeleteNoteForever: function( note ) {
		const previousIndex = this.getPreviousNoteIndex( note );
		this.props.actions.deleteNoteForever( {
			noteBucket: this.props.noteBucket,
			note,
			previousIndex
		} );
	},

	onRevisions: function( note ) {
		this.props.actions.noteRevisions( {
			noteBucket: this.props.noteBucket,
			note
		} );
		analytics.tracks.recordEvent( 'editor_versions_accessed' );
	},

	onToolbarOutsideClick: function( isNavigationBar ) {
		const {
			actions: { toggleNavigation },
			appState: { dialogs, showNavigation }
		} = this.props;

		if ( dialogs.length > 0 ) {
			return;
		}

		if ( isNavigationBar && showNavigation ) {
			return toggleNavigation();
		}
	},

	render: function() {
		const {
			appState: state,
			authIsPending,
			isAuthorized,
			noteBucket,
			selectAllNotes,
			selectTrashedNotes,
		} = this.props;

		const electron = get( this.state, 'electron' );
		const isMacApp = isElectronMac();
		const { settings, isSmallScreen } = this.props;
		const filteredNotes = filterNotes( state );

		const noteIndex = Math.max( state.previousIndex, 0 );
		const selectedNote = isSmallScreen || state.note ? state.note : filteredNotes[ noteIndex ];

		const appClasses = classNames( 'app', `theme-${settings.theme}`, {
			'touch-enabled': ( 'ontouchstart' in document.body ),
		} );

		const mainClasses = classNames( 'simplenote-app', {
			'note-open': selectedNote,
			'note-info-open': state.showNoteInfo,
			'navigation-open': state.showNavigation,
			'is-electron': isElectron(),
			'is-macos': isMacApp
		} );

		return (
			<div className={appClasses}>
				{ isElectron() &&
					<ContextMenu Menu={ electron.Menu } window={ electron.currentWindow }>
						<MenuItem label="Undo" role="undo" />
						<MenuItem label="Redo" role="redo" />
						<Separator />
						<MenuItem label="Cut" role="cut" />
						<MenuItem label="Copy" role="copy" />
						<MenuItem label="Paste" role="paste" />
						<MenuItem label="Select All" role="selectall" />
					</ContextMenu>
				}
				{ isAuthorized ?
						<div className={mainClasses}>
							{ state.showNavigation &&
							<NavigationBar
								onSelectAllNotes={ selectAllNotes }
								onSelectTrash={ selectTrashedNotes }
								onSelectTag={this.onSelectTag}
								onSettings={this.onSettings}
								onAbout={this.onAbout}
								onEditTags={() => this.props.actions.editTags() }
								onRenameTag={this.onRenameTag}
								onTrashTag={this.onTrashTag}
								onReorderTags={this.onReorderTags}
								editingTags={state.editingTags}
								showTrash={state.showTrash}
								onOutsideClick={this.onToolbarOutsideClick} />
							}
							<div className="source-list theme-color-bg theme-color-fg">
								<div className="search-bar theme-color-border">
									<button title="Tags" className="button button-borderless" onClick={() => this.props.actions.toggleNavigation() }>
										<TagsIcon />
									</button>
									<SearchField
										onSearch={this.onSearch}
										onSearchFocused={this.onSearchFocused} />
									<button title="New Note" className="button button-borderless" disabled={state.showTrash} onClick={this.onNewNote}>
										<NewNoteIcon />
									</button>
								</div>
								<NoteList noteBucket={ noteBucket } />
							</div>
							<NoteEditor
								allTags={ state.tags }
								editorMode={state.editorMode}
								note={selectedNote}
								revisions={state.revisions}
								onSetEditorMode={this.onSetEditorMode}
								onUpdateContent={this.onUpdateContent}
								onUpdateNoteTags={this.onUpdateNoteTags}
								onTrashNote={this.onTrashNote}
								onRestoreNote={this.onRestoreNote}
								onShareNote={this.onShareNote}
								onDeleteNoteForever={this.onDeleteNoteForever}
								onRevisions={this.onRevisions}
								onCloseNote={() => this.props.actions.closeNote()}
								onNoteInfo={() => this.props.actions.toggleNoteInfo()}
								shouldPrint={state.shouldPrint}
								onNotePrinted={this.onNotePrinted} />
							{ state.showNoteInfo &&
								<NoteInfo noteBucket={ noteBucket } />
							}
						</div>
				:
					<Auth
						authPending={ authIsPending }
						isAuthenticated={ isAuthorized }
						onAuthenticate={ this.props.onAuthenticate }
						isMacApp={ isMacApp }
					/>
				}
				{ ( this.props.appState.dialogs.length > 0 ) &&
					<div className="dialogs">
						{ this.renderDialogs() }
					</div> }
			</div>
		)
	},

	renderDialogs() {
		var { dialogs } = this.props.appState;

		const makeDialog = ( dialog, key ) => ( [
			dialog.modal && <div key="overlay" className="dialogs-overlay" onClick={ null } />,
			this.renderDialog( dialog, key )
		] );

		return flowRight( compact, concat, map )( dialogs, makeDialog );
	},

	renderDialog( { params, ...dialog }, key ) {
		var DialogComponent = Dialogs[ dialog.type ];

		if ( DialogComponent == null ) {
			throw new Error( 'Unknown dialog type.' );
		}

		return (
			<DialogComponent {...this.props} { ...{ key, dialog, params } } />
		);
	}
} ) );

export default browserShell( App );
